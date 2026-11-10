// Probe for FW-C-046 (Copilot: the Owner sees each cycle draft and approves or rejects it):
// `pnpm probe flows/copilot`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=flow_drafts,
// the Owner controls under /v1/supervisor with the CLI token fwd prints, the drafts folder
// $FW_HOME/flows/<key>/drafts/, the outbox $FW_HOME/outbox/<key>/, `fw supervisor drafts <flow> --json`
// (FW_PORT naming fwd's port), and the database read-only.
// The surface this probe expects (CLI token on every route):
//   GET  /v1/supervisor/flows/{key}/drafts             -> { data: [{ id, fire_id, lead_id, channel,
//        subject, body, status, held? }] }, newest first
//   POST /v1/supervisor/flows/{key}/drafts/{id}/approve -> 200 { data: { id, status: 'handed_off' } }
//        at Copilot or Autopilot; 409 with a reason otherwise (needs_copilot at Draft, rejected, ...)
//   POST /v1/supervisor/flows/{key}/drafts/{id}/reject  -> 200 { data: { id, status: 'rejected' } }
//
// Proves, in order:
//   1. At Copilot a cycle's drafts wait for the Owner: the list shows them waiting_for_owner and the
//      outbox is empty. Listing them needs the CLI token (401 without).
//   2. Approving one hands it off exactly like Autopilot: one outbox file and one notification.queued
//      event for it, and the draft reads handed_off. Approving it again adds nothing.
//   3. Rejecting another marks it rejected; approving a rejected draft answers 409 and hands nothing off.
//   4. At Draft, approving answers 409 with a reason that starts needs_copilot, and nothing is handed off.
//   5. `fw supervisor drafts <flow> --json` lists the same drafts with the same statuses.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  check,
  count,
  DAEMON_BIN,
  freshHome,
  fwJson,
  killAndWait,
  missing,
  openDbReadonly,
  probe,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/copilot';
const KEY = 'neighborhood-activation';
const kids = [];

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function http(port, method, path, token, body) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 10000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        ok({ status: res.statusCode, body: text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function startFwd(home) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim(), env: { ...env, FW_PORT: String(port) } };
}

const outboxFiles = (home) => {
  const dir = join(home, 'outbox', KEY);
  return existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : [];
};

async function queued(home, id) {
  const db = await openDbReadonly(home);
  try {
    return count(
      db,
      "SELECT count(*) FROM events WHERE type = 'notification.queued' AND idempotency_key = ?",
      `flow_handoff:${KEY}:${id}`,
    );
  } finally {
    db.close();
  }
}

/** Runs one cycle by hand and waits for its run report; answers the fire id. */
async function runCycle(f, home) {
  const r = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/run`, f.token);
  check(r.json?.data?.outcome === 'fired', `running ${KEY}: ${r.body.slice(0, 200)}`);
  const fireId = r.json.data.fire_id;
  await waitFor(
    async () => {
      const db = await openDbReadonly(home);
      try {
        return db
          .prepare("SELECT body FROM status_reports WHERE kind = 'run'")
          .all()
          .some((x) => JSON.parse(x.body).fire_id === fireId);
      } finally {
        db.close();
      }
    },
    { timeoutMs: 30000, everyMs: 250, what: 'the cycle to write its run report' },
  );
  return fireId;
}

const reason = (r) => String(r.json?.error?.reason ?? r.json?.error?.message ?? r.json?.error?.code ?? '');

await probe(NAME, async () => {
  const home = freshHome('copilot');
  try {
    const f = await startFwd(home);
    const base = `/v1/supervisor/flows/${KEY}`;
    check((await http(f.port, 'POST', `${base}/enable`, f.token)).status === 200, `enabling ${KEY} failed`);
    const dial = await http(f.port, 'POST', `${base}/dial`, f.token, { stop: 'copilot' });
    check(dial.status === 200, `setting ${KEY} to copilot answered ${dial.status}: ${dial.body.slice(0, 200)}`);

    // ---- 1. at Copilot the drafts wait, and listing them needs the token ---------------------------
    const fire1 = await runCycle(f, home);
    const anon = await http(f.port, 'GET', `${base}/drafts`, null);
    if (anon.status === 404) missing(`GET ${base}/drafts answered 404 (no drafts route)`);
    check(anon.status === 401, `listing drafts without a token answered ${anon.status}, want 401`);
    const list1 = await http(f.port, 'GET', `${base}/drafts`, f.token);
    check(list1.status === 200 && Array.isArray(list1.json?.data), `listing drafts: ${list1.body.slice(0, 200)}`);
    const mine = list1.json.data.filter((x) => x.fire_id === fire1);
    check(mine.length >= 2, `drafts listed for the Copilot cycle: ${mine.length}, want at least 2`);
    for (const x of mine)
      check(
        x.status === 'waiting_for_owner' && typeof x.body === 'string' && typeof x.id === 'string',
        `a Copilot draft before approval: ${JSON.stringify(x).slice(0, 200)}`,
      );
    check(outboxFiles(home).length === 0, 'a Copilot cycle wrote to the outbox before the Owner approved');

    // ---- 2. approving hands one off, once ----------------------------------------------------------
    const [a, b] = mine;
    const ok = await http(f.port, 'POST', `${base}/drafts/${a.id}/approve`, f.token);
    check(
      ok.status === 200 && ok.json?.data?.status === 'handed_off',
      `approving ${a.id} answered ${ok.status}: ${ok.body.slice(0, 200)}`,
    );
    check(outboxFiles(home).length === 1 && outboxFiles(home)[0] === `${a.id}.json`, `outbox after approval: ${outboxFiles(home)}`);
    check((await queued(home, a.id)) === 1, `notification.queued events for ${a.id}: want 1`);
    const again = await http(f.port, 'POST', `${base}/drafts/${a.id}/approve`, f.token);
    check(again.status === 200, `approving ${a.id} twice answered ${again.status}`);
    check(outboxFiles(home).length === 1 && (await queued(home, a.id)) === 1, 'approving twice handed the draft off twice');
    const listed = (await http(f.port, 'GET', `${base}/drafts`, f.token)).json.data;
    check(listed.find((x) => x.id === a.id)?.status === 'handed_off', `${a.id} is not listed as handed_off`);

    // ---- 3. rejecting marks it, and a rejected draft cannot be approved ---------------------------
    const rej = await http(f.port, 'POST', `${base}/drafts/${b.id}/reject`, f.token);
    check(rej.status === 200 && rej.json?.data?.status === 'rejected', `rejecting ${b.id}: ${rej.body.slice(0, 200)}`);
    const late = await http(f.port, 'POST', `${base}/drafts/${b.id}/approve`, f.token);
    check(late.status === 409, `approving a rejected draft answered ${late.status}, want 409`);
    check((await queued(home, b.id)) === 0 && outboxFiles(home).length === 1, 'a rejected draft was handed off');

    // ---- 4. at Draft the Owner sends by hand: approving is refused --------------------------------
    check((await http(f.port, 'POST', `${base}/dial`, f.token, { stop: 'draft' })).status === 200, 'setting draft failed');
    const fire2 = await runCycle(f, home);
    const c = (await http(f.port, 'GET', `${base}/drafts`, f.token)).json.data.find((x) => x.fire_id === fire2);
    check(c?.status === 'waiting_for_owner', `a Draft-stop draft: ${JSON.stringify(c).slice(0, 200)}`);
    const refused = await http(f.port, 'POST', `${base}/drafts/${c.id}/approve`, f.token);
    check(
      refused.status === 409 && reason(refused).includes('needs_copilot'),
      `approving at Draft answered ${refused.status} ${refused.body.slice(0, 200)}, want 409 needs_copilot`,
    );
    check((await queued(home, c.id)) === 0 && outboxFiles(home).length === 1, 'approving at Draft handed a draft off');

    // ---- 5. the CLI lists the same drafts ----------------------------------------------------------
    const cli = fwJson(['supervisor', 'drafts', KEY], { home, env: f.env });
    check(cli.status === 0, `fw supervisor drafts exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    const cd = cli.json?.data ?? cli.json;
    check(Array.isArray(cd), `fw supervisor drafts --json printed ${JSON.stringify(cli.json).slice(0, 200)}`);
    for (const [id, st] of [
      [a.id, 'handed_off'],
      [b.id, 'rejected'],
      [c.id, 'waiting_for_owner'],
    ])
      check(cd.find((x) => x.id === id)?.status === st, `fw supervisor drafts says ${id} is ${cd.find((x) => x.id === id)?.status}, want ${st}`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
