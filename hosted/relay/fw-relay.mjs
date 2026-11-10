#!/usr/bin/env node
// fw-relay: copies your local fwd's read data to your hosted FlowWeb mirror.
//
// It only makes outbound requests. fwd stays loopback-only; nothing on your machine listens
// for the hosted site. What is copied: the JSON /v1 read routes the web UI uses (status,
// projects, ledger rows, runs and steps, open decision cards, evidence bundle metadata,
// events, spend, budgets, policy). What is never copied: diffs (they can contain your code),
// the event stream, pairing or session data, and anything under $FW_HOME besides cli.token,
// which is read to authenticate to fwd and never sent.
//
// Usage:
//   FW_RELAY_SITE=https://your-site.vercel.app FW_RELAY_TOKEN=fwr_... node hosted/relay/fw-relay.mjs
//   add --once to push one snapshot and exit, or --dump <file> to write it to a file instead.
// Env: FW_HOME (default ~/.flowweb), FW_PORT (7317), FW_RELAY_INTERVAL_S (60),
//      FW_RELAY_TOKEN or the file $FW_HOME/relay.token, FW_RELAY_LABEL (shown on the site).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mirrorKey } from '../server/mirror.mjs';

const VERSION = '0.1.0';
const FW_HOME = process.env.FW_HOME ?? join(homedir(), '.flowweb');
const FWD = `http://127.0.0.1:${process.env.FW_PORT ?? 7317}/v1`;
const SITE = (process.env.FW_RELAY_SITE ?? '').replace(/\/$/, '');
const INTERVAL_S = Math.max(15, Number(process.env.FW_RELAY_INTERVAL_S ?? 60));
const DUMP = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null;
const ONCE = process.argv.includes('--once') || Boolean(DUMP);
const DAYS = 8;
const GROUPS = ['project', 'vendor', 'agent'];

function readSecret(envName, file) {
  if (process.env[envName]) return process.env[envName].trim();
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const RELAY_TOKEN = readSecret('FW_RELAY_TOKEN', join(FW_HOME, 'relay.token'));
const CLI_TOKEN = readSecret('FW_CLI_TOKEN', join(FW_HOME, 'pairing', 'cli.token'));

if (!DUMP && (!SITE || !RELAY_TOKEN)) {
  console.error(
    'fw-relay: set FW_RELAY_SITE to your hosted URL and FW_RELAY_TOKEN (or $FW_HOME/relay.token) ' +
      'to a token from Settings > Machines on the site.',
  );
  process.exit(2);
}

async function fwd(path, params = {}) {
  const url = `${FWD}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${CLI_TOKEN}` },
  });
  if (!res.ok) {
    const e = new Error(`fwd ${path}: HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Every page of a list route, merged into one envelope (as_of of the first page). */
async function all(path, params = {}, maxItems = 2000) {
  let first = null;
  let data = [];
  let cursor = '';
  do {
    const env = await fwd(path, { ...params, limit: '200', ...(cursor ? { cursor } : {}) });
    first ??= env;
    data = data.concat(env.data);
    cursor = env.next_cursor ?? '';
  } while (cursor && data.length < maxItems);
  return { ...first, data, next_cursor: null };
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

async function snapshot() {
  const out = {};
  const put = (key, env) => {
    out[key] = env;
  };

  const status = await fwd('/status');
  put('/status', status);
  for (const p of ['/policy', '/budgets']) put(p, await fwd(p));
  // The Supervisor and each flow's view. Older fwd builds have neither: skip a 404, fail on anything else.
  const ifFound = (e) => {
    if (e?.status === 404) return null;
    throw e;
  };
  const supervisor = await fwd('/supervisor').catch(ifFound);
  if (supervisor) {
    put('/supervisor', supervisor);
    const keys = (supervisor.data?.flows ?? []).map((f) => f?.key).filter(Boolean);
    for (const key of new Set(keys)) {
      const view = await fwd(`/flows/${encodeURIComponent(key)}`).catch(ifFound);
      if (view) put(`/flows/${key}`, view);
      // The flow's settings, which the Activation page shows. Flows without an admin API answer 404.
      const cfg = await fwd(`/flows/${encodeURIComponent(key)}/config`).catch(ifFound);
      if (cfg) put(`/flows/${key}/config`, cfg);
    }
  }
  put('/status-reports', await all('/status-reports', {}, 50));
  // FW-C-039: the Get started checklist. An older fwd has no /setup; the site then shows it as not synced.
  try {
    put('/setup', await fwd('/setup'));
  } catch {
    // skipped, not invented
  }

  const projects = await all('/projects');
  put('/projects', projects);
  const rows = await all('/ledger/rows');
  put('/ledger/rows', rows);
  const runs = await all('/runs', {}, 200);
  put('/runs', runs);
  const cards = await all('/decision-cards', { status: 'open' });
  put('/decision-cards', cards);

  const head = Number(status.head_seq ?? 0);
  put('/events', await all('/events', { after_seq: String(Math.max(0, head - 1000)) }, 1000));

  const evidenceIds = new Set();
  await pool(projects.data, 4, async (p) => put(`/projects/${p.id}`, await fwd(`/projects/${p.id}`)));
  await pool(rows.data, 6, async (r) => {
    const d = await fwd(`/ledger/rows/${r.id}`);
    put(`/ledger/rows/${r.id}`, d);
    for (const e of d.data?.evidence ?? []) evidenceIds.add(e.id);
  });
  await pool(runs.data, 6, async (r) => {
    put(`/runs/${r.id}`, await fwd(`/runs/${r.id}`));
    put(`/runs/${r.id}/steps`, await all(`/runs/${r.id}/steps`, {}, 1000));
  });
  await pool(cards.data, 4, async (c) =>
    put(`/decision-cards/${c.id}`, await fwd(`/decision-cards/${c.id}`)),
  );
  await pool([...evidenceIds], 4, async (id) =>
    put(`/evidence-bundles/${id}`, await fwd(`/evidence-bundles/${id}`)),
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: DAYS }, (_, i) => new Date(today.getTime() - i * 86_400_000));
  const now = new Date().toISOString();
  await pool(
    days.flatMap((d) => GROUPS.map((g) => [d, g])),
    4,
    async ([d, g]) => {
      const from = d.toISOString();
      const next = new Date(d.getTime() + 86_400_000).toISOString();
      const to = next > now ? now : next;
      try {
        put(`/spend/day/${g}/${from.slice(0, 10)}`, await fwd('/spend', { group_by: g, from, to }));
      } catch {
        // A group fwd does not support is skipped, not invented.
      }
    },
  );

  // Normalise keys exactly as the server looks them up.
  const keyed = {};
  for (const [k, v] of Object.entries(out)) {
    const [p, q = ''] = k.split('?');
    keyed[mirrorKey(p, q)] = v;
  }
  return { entries: keyed, status };
}

/**
 * Which sign-ins FlowWeb can use on this machine, as yes or no only. Secrets are never read:
 * the keychain lookups send their output to /dev/null and only the exit code comes back.
 * null means this machine cannot tell (no keychain tool, or the CLI is not installed).
 */
function exitOk(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000 });
  if (r.error) return null;
  return r.status === 0;
}
function stored(handle) {
  if (process.platform === 'darwin') return exitOk('security', ['find-generic-password', '-s', 'flowweb', '-a', handle]);
  if (process.platform === 'linux') return exitOk('secret-tool', ['lookup', 'service', 'flowweb', 'handle', handle]);
  return null;
}
function accounts() {
  return {
    checked_at: new Date().toISOString(),
    claude_api_key: stored('crd_claude0001'),
    claude_signin_token: stored('crd_claude0002'),
    codex_api_key: stored('crd_codex0001'),
    codex_signin: exitOk('codex', ['login', 'status']),
  };
}

/**
 * The last `fw accounts check` result, if any: whether each account passed its tiny real test
 * call. Only known fields are copied, so nothing else in the file can ride along. Never a secret:
 * the check writes plain words and booleans, and redacts vendor error text.
 */
const ACCOUNT_IDS = ['claude_signin', 'claude_api_key', 'codex_signin', 'codex_api_key'];
const short = (v) => (typeof v === 'string' ? v.slice(0, 240) : null);
function accountTest(text) {
  try {
    const r = JSON.parse(text);
    const accounts = {};
    for (const a of Array.isArray(r.accounts) ? r.accounts : []) {
      if (!ACCOUNT_IDS.includes(a?.id)) continue;
      const tri = (v) => (v === true || v === false ? v : null);
      accounts[a.id] = { set_up: tri(a.set_up), ok: tri(a.ok), detail: short(a.detail), fix: short(a.fix) };
    }
    return { checked_at: short(r.checked_at), accounts, start_command: short(r.start_command) };
  } catch {
    return null;
  }
}
function lastAccountTest() {
  try {
    return accountTest(readFileSync(join(FW_HOME, 'accounts-check.json'), 'utf8'));
  } catch {
    return null; // never run on this machine
  }
}

let target = null;
async function hostedConfig() {
  if (target) return target;
  // Optional: point straight at Supabase when the site itself is behind a login wall.
  if (process.env.FW_RELAY_SUPABASE_URL && process.env.FW_RELAY_SUPABASE_ANON_KEY) {
    target = {
      supabase_url: process.env.FW_RELAY_SUPABASE_URL,
      anon_key: process.env.FW_RELAY_SUPABASE_ANON_KEY,
    };
    return target;
  }
  const res = await fetch(`${SITE}/v1/hosted/config`);
  if (!res.ok) throw new Error(`site config: HTTP ${res.status}`);
  target = (await res.json()).data;
  return target;
}

async function push(entries, report) {
  const cfg = await hostedConfig();
  const res = await fetch(`${cfg.supabase_url}/rest/v1/rpc/fw_relay_ingest`, {
    method: 'POST',
    headers: {
      apikey: cfg.anon_key,
      authorization: `Bearer ${cfg.anon_key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_token: RELAY_TOKEN, p_entries: entries, p_report: report }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`push refused: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function once() {
  const started = Date.now();
  const { entries, status } = await snapshot();
  const report = {
    relay_version: VERSION,
    label: process.env.FW_RELAY_LABEL ?? hostname(),
    fwd_version: status.data?.version ?? null,
    fwd_started_at: status.data?.started_at ?? null,
    head_seq: status.head_seq ?? null,
    entries: Object.keys(entries).length,
    took_ms: Date.now() - started,
    accounts: accounts(),
    account_test: lastAccountTest(),
  };
  if (DUMP) {
    // Write the snapshot to a file instead of pushing it (to inspect what would be sent).
    writeFileSync(DUMP, JSON.stringify({ entries, report }), { mode: 0o600 });
    console.log(`fw-relay: wrote ${report.entries} entries to ${DUMP}`);
    return;
  }
  const r = await push(entries, report);
  // FW-C-039: `fw setup` counts the live site as working only from an accepted push. No secret here.
  try {
    writeFileSync(
      join(FW_HOME, 'relay-last-push.json'),
      JSON.stringify({ synced_at: r.synced_at ?? new Date().toISOString(), site: SITE, stored: r.stored }),
      { mode: 0o600 },
    );
  } catch (e) {
    console.error(`fw-relay: could not record the push in ${FW_HOME}: ${e.message}`);
  }
  console.log(`fw-relay: pushed ${r.stored} entries at ${r.synced_at} (head_seq ${report.head_seq})`);
}

async function main() {
  for (;;) {
    try {
      await once();
    } catch (e) {
      console.error(`fw-relay: ${e.message}`);
      if (ONCE) process.exit(1);
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

main();
