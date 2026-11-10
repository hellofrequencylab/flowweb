// Probe for FW-C-051 (AI rewrites a flow draft from the Owner's instruction, for the Owner to review):
// `pnpm probe flows/draft-rewrite`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=flow_drafts
// (the cycle that writes drafts); a rewrite runs the fake vendor's draft_rewrite scenario, which
// writes rewrite.json in its folder. The Owner controls under /v1/supervisor with the CLI token fwd
// prints, the database read-only, and `fw supervisor rewrite <flow> <id> --how <text> --json`.
// The surface this probe expects (CLI token):
//   POST /v1/supervisor/flows/{key}/drafts/{id}/rewrite  { instruction, subject?, body? }
//        -> 200 { data: { id, subject, body, instruction } }: a proposal; the draft file is unchanged
//        -> 400 when instruction is missing or empty
//        -> 409 with a reason starting handed_off for a draft in the outbox, kill_switch or paused when
//           the kill switch or the Supervisor pause is on
//
// Proves, in order:
//   1. Rewriting needs the CLI token (401 without), and an empty instruction answers 400.
//   2. A rewrite answers a proposed subject and body from the flow's engine (the fake vendor's text
//      names the instruction), and the draft itself is unchanged until the Owner saves an edit.
//   3. Text the Owner passes in (an unsaved edit) is what gets rewritten.
//   4. The rewrite's model spend is recorded for the flow's stream.
//   5. A handed-off draft answers 409 handed_off; while the Supervisor is paused a rewrite answers 409 paused.
//   6. `fw supervisor rewrite <flow> <id> --how <text> --json` answers a proposal too.
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

const NAME = 'flows/draft-rewrite';
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

async function rewriteSpend(home) {
  const db = await openDbReadonly(home);
  try {
    return count(db, "SELECT count(*) FROM spend_entries WHERE idempotency_key LIKE 'flow_rewrite:%'");
  } finally {
    db.close();
  }
}

await probe(NAME, async () => {
  const home = freshHome('draft-rewrite');
  try {
    const f = await startFwd(home);
    const base = `/v1/supervisor/flows/${KEY}`;
    check((await http(f.port, 'POST', `${base}/enable`, f.token)).status === 200, `enabling ${KEY} failed`);
    const dial = await http(f.port, 'POST', `${base}/dial`, f.token, { stop: 'copilot' });
    check(dial.status === 200, `setting ${KEY} to copilot answered ${dial.status}: ${dial.body.slice(0, 200)}`);
    const fire = await runCycle(f, home);
    const list = async () => (await http(f.port, 'GET', `${base}/drafts`, f.token)).json?.data ?? [];
    const mine = (await list()).filter((x) => x.fire_id === fire && x.status === 'waiting_for_owner');
    check(mine.length >= 2, `drafts from the cycle: ${mine.length}, want at least 2`);
    const [a, b] = mine;

    // ---- 1. token and input ------------------------------------------------------------------------
    const anon = await http(f.port, 'POST', `${base}/drafts/${a.id}/rewrite`, null, { instruction: 'Shorter' });
    if (anon.status === 404 || anon.status === 405) missing(`POST ${base}/drafts/{id}/rewrite answered ${anon.status} (no rewrite route)`);
    check(anon.status === 401, `rewriting without a token answered ${anon.status}, want 401`);
    for (const bad of [{}, { instruction: '   ' }, { instruction: 5 }]) {
      const r = await http(f.port, 'POST', `${base}/drafts/${a.id}/rewrite`, f.token, bad);
      check(r.status === 400, `rewriting with ${JSON.stringify(bad)} answered ${r.status}, want 400`);
    }

    // ---- 2. a proposal, and the draft is unchanged ----------------------------------------------------
    const spentBefore = await rewriteSpend(home);
    const r = await http(f.port, 'POST', `${base}/drafts/${a.id}/rewrite`, f.token, { instruction: 'Make it warmer' });
    check(r.status === 200, `rewriting ${a.id} answered ${r.status}: ${r.body.slice(0, 300)}`);
    const p = r.json?.data;
    check(typeof p?.body === 'string' && p.body.length > 0, `the rewrite answered no body: ${r.body.slice(0, 200)}`);
    check(p.body !== a.body && p.body.includes('Make it warmer'), `the rewrite body does not come from the engine: ${p.body.slice(0, 200)}`);
    check(p.id === a.id, `the rewrite answered id ${p.id}, want ${a.id}`);
    const same = (await list()).find((x) => x.id === a.id);
    check(same.body === a.body && same.subject === a.subject && same.status === 'waiting_for_owner', 'a rewrite changed the draft before the Owner saved it');

    // ---- 3. an unsaved edit is what gets rewritten -------------------------------------------------
    const r2 = await http(f.port, 'POST', `${base}/drafts/${a.id}/rewrite`, f.token, {
      instruction: 'Shorter',
      subject: 'Unsaved subject',
      body: 'Unsaved body text from the editor.',
    });
    check(r2.status === 200, `rewriting with unsaved text answered ${r2.status}: ${r2.body.slice(0, 200)}`);
    check(r2.json.data.body.includes('Unsaved body text from the editor.'), 'the rewrite did not start from the text the Owner passed in');

    // ---- 4. spend is recorded -----------------------------------------------------------------------
    check((await rewriteSpend(home)) >= spentBefore + 2, 'the rewrites recorded no model spend (spend_entries flow_rewrite:...)');

    // ---- 5. handed off, and the kill switch ---------------------------------------------------------
    const ok = await http(f.port, 'POST', `${base}/drafts/${b.id}/approve`, f.token);
    check(ok.status === 200, `approving ${b.id} answered ${ok.status}: ${ok.body.slice(0, 200)}`);
    const late = await http(f.port, 'POST', `${base}/drafts/${b.id}/rewrite`, f.token, { instruction: 'Shorter' });
    check(late.status === 409 && reason(late).includes('handed_off'), `rewriting a handed-off draft answered ${late.status} ${late.body.slice(0, 200)}, want 409 handed_off`);
    const pause = await http(f.port, 'POST', '/v1/supervisor/pause', f.token);
    check(pause.status === 200, `pausing the Supervisor answered ${pause.status}: ${pause.body.slice(0, 200)}`);
    const stopped = await http(f.port, 'POST', `${base}/drafts/${a.id}/rewrite`, f.token, { instruction: 'Shorter' });
    check(
      stopped.status === 409 && reason(stopped).includes('paused'),
      `rewriting while the Supervisor is paused answered ${stopped.status} ${stopped.body.slice(0, 200)}, want 409 paused`,
    );
    check((await http(f.port, 'POST', '/v1/supervisor/resume', f.token)).status === 200, 'resuming the Supervisor failed');

    // ---- 6. the CLI ---------------------------------------------------------------------------------
    const cli = fwJson(['supervisor', 'rewrite', KEY, a.id, '--how', 'Friendlier'], { home, env: f.env });
    check(cli.status === 0, `fw supervisor rewrite exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    const cd = cli.json?.data ?? cli.json;
    check(typeof cd?.body === 'string' && cd.body.includes('Friendlier'), `fw supervisor rewrite printed ${JSON.stringify(cli.json).slice(0, 200)}`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
