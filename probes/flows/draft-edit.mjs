// Probe for FW-C-050 (the Owner edits a draft's subject and text before it goes out):
// `pnpm probe flows/draft-edit`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=flow_drafts,
// the Owner controls under /v1/supervisor with the CLI token fwd prints, the outbox
// $FW_HOME/outbox/<key>/, and `fw supervisor edit <flow> <id> --subject <s> --body <b> --json`
// (FW_PORT naming fwd's port).
// The surface this probe expects (CLI token):
//   POST /v1/supervisor/flows/{key}/drafts/{id}/edit  { subject?, body? }
//        -> 200 { data: { id, subject, body, status, edited_at } }
//        -> 400 when neither field is given, the body is empty, or a field is not a string
//        -> 409 with a reason starting handed_off once the draft is in the outbox
//
// Proves, in order:
//   1. Editing needs the CLI token (401 without).
//   2. An edit changes the subject and body the list shows, keeps the status, and stamps edited_at.
//   3. A bad edit (no fields, an empty body) answers 400 and changes nothing.
//   4. Approving the edited draft at Copilot hands off the edited text: the outbox file has the new body.
//   5. Once handed off, an edit answers 409 handed_off and the outbox file is unchanged.
//   6. `fw supervisor edit <flow> <id> --subject .. --body .. --json` edits another draft the same way.
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

const NAME = 'flows/draft-edit';
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
  const home = freshHome('draft-edit');
  try {
    const f = await startFwd(home);
    const base = `/v1/supervisor/flows/${KEY}`;
    check((await http(f.port, 'POST', `${base}/enable`, f.token)).status === 200, `enabling ${KEY} failed`);
    const dial = await http(f.port, 'POST', `${base}/dial`, f.token, { stop: 'copilot' });
    check(dial.status === 200, `setting ${KEY} to copilot answered ${dial.status}: ${dial.body.slice(0, 200)}`);
    const fire = await runCycle(f, home);
    const drafts = (await http(f.port, 'GET', `${base}/drafts`, f.token)).json?.data ?? [];
    const mine = drafts.filter((x) => x.fire_id === fire && x.status === 'waiting_for_owner');
    check(mine.length >= 2, `drafts from the cycle: ${mine.length}, want at least 2`);
    const [a, b] = mine;
    const list = async () => (await http(f.port, 'GET', `${base}/drafts`, f.token)).json.data;

    // ---- 1. the token is needed ---------------------------------------------------------------------
    const anon = await http(f.port, 'POST', `${base}/drafts/${a.id}/edit`, null, { subject: 'x' });
    if (anon.status === 404 || anon.status === 405) missing(`POST ${base}/drafts/{id}/edit answered ${anon.status} (no edit route)`);
    check(anon.status === 401, `editing without a token answered ${anon.status}, want 401`);

    // ---- 2. an edit changes subject and body, keeps the status -----------------------------------------
    const SUBJ = 'Edited subject from the probe';
    const BODY = 'Edited body from the probe.\nSecond line.';
    const ed = await http(f.port, 'POST', `${base}/drafts/${a.id}/edit`, f.token, { subject: SUBJ, body: BODY });
    check(ed.status === 200, `editing ${a.id} answered ${ed.status}: ${ed.body.slice(0, 200)}`);
    const after = (await list()).find((x) => x.id === a.id);
    check(after?.subject === SUBJ && after?.body === BODY, `after the edit the list shows ${JSON.stringify(after).slice(0, 200)}`);
    check(after.status === 'waiting_for_owner', `an edit changed the status to ${after.status}`);
    check(typeof after.edited_at === 'string' && !Number.isNaN(Date.parse(after.edited_at)), 'an edit did not stamp edited_at');

    // ---- 3. bad edits are refused and change nothing ---------------------------------------------------
    for (const bad of [{}, { body: '' }, { subject: 7 }]) {
      const r = await http(f.port, 'POST', `${base}/drafts/${a.id}/edit`, f.token, bad);
      check(r.status === 400, `editing with ${JSON.stringify(bad)} answered ${r.status}, want 400`);
    }
    const still = (await list()).find((x) => x.id === a.id);
    check(still.subject === SUBJ && still.body === BODY, 'a refused edit changed the draft');

    // ---- 4. approving hands off the edited text ------------------------------------------------------
    const ok = await http(f.port, 'POST', `${base}/drafts/${a.id}/approve`, f.token);
    check(ok.status === 200, `approving the edited ${a.id} answered ${ok.status}: ${ok.body.slice(0, 200)}`);
    check(outboxFiles(home).includes(`${a.id}.json`), `outbox after approval: ${outboxFiles(home)}`);
    const sent = readFileSync(join(home, 'outbox', KEY, `${a.id}.json`), 'utf8');
    check(sent.includes('Edited body from the probe.'), 'the outbox file does not carry the edited body');

    // ---- 5. a handed-off draft cannot be edited ------------------------------------------------------
    const late = await http(f.port, 'POST', `${base}/drafts/${a.id}/edit`, f.token, { body: 'Too late' });
    check(
      late.status === 409 && reason(late).includes('handed_off'),
      `editing a handed-off draft answered ${late.status} ${late.body.slice(0, 200)}, want 409 handed_off`,
    );
    check(readFileSync(join(home, 'outbox', KEY, `${a.id}.json`), 'utf8') === sent, 'an edit after hand-off changed the outbox file');
    check((await queued(home, a.id)) === 1, `notification.queued events for ${a.id}: want 1`);

    // ---- 6. the CLI edits too ----------------------------------------------------------------------
    const cli = fwJson(['supervisor', 'edit', KEY, b.id, '--subject', 'From the CLI', '--body', 'CLI body'], { home, env: f.env });
    check(cli.status === 0, `fw supervisor edit exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    const viaCli = (await list()).find((x) => x.id === b.id);
    check(viaCli?.subject === 'From the CLI' && viaCli?.body === 'CLI body', `after fw supervisor edit: ${JSON.stringify(viaCli).slice(0, 200)}`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
