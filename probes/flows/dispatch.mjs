// Probe for FW-C-038 (dispatch: an admitted fire runs one cycle of the flow): `pnpm probe flows/dispatch`.
// Tier 0.
// Surfaces: the daemon fwd (one node process on a fresh FW_HOME, with FW_VENDOR=fake and
// FW_FAKE_SCENARIO=flow_drafts so the cycle runs on the fake adapter without a network or keys),
// GET /v1/supervisor and the Owner controls under /v1/supervisor with the CLI token fwd prints,
// the new POST /v1/supervisor/flows/{key}/run and `fw supervisor run <flow> --json`, the drafts
// folder $FW_HOME/flows/<key>/drafts/, and the database read-only.
// The surface this probe expects:
//   POST /v1/supervisor/flows/{key}/run (CLI token) fires the flow's stream by hand through the
//   scheduler, so the Supervisor decides it like any fire. It answers 200 with
//   { data: { fire_id, outcome: 'fired' | 'held', reason? } }.
//   A fired fire of a flow runs one cycle on the routed adapter. When the cycle ends, fwd writes one
//   status_reports row of kind 'run' whose body has stream_id, fire_id, adapter, outcome
//   ('drafted' | 'dry' | 'failed') and drafts (a count); one draft file per item at
//   $FW_HOME/flows/<key>/drafts/<id>.json with flow, fire_id, body and status; and its spend as
//   spend_entries rows carrying the stream_id.
//
// Proves, in order:
//   1. Turning the flow on registers its stream with the scheduler: the streams table has the
//      flow's stream, active, and a stream.created event names it.
//   2. Running the flow by hand needs the CLI token: without it the request answers 401 and nothing
//      fires.
//   3. With the token, the fire is recorded as fired (trigger manual) and one cycle runs: one run
//      report with outcome drafted, at least one draft file, every draft waiting for the Owner at
//      Draft, and spend recorded against the flow's stream. GET /v1/supervisor then shows the
//      flow's spend above zero.
//   4. At Draft nothing is handed off: no outbox file and no notification.queued event.
//   5. With the flow turned off, running it by hand is held by flow_disabled, and no cycle runs.
//   6. `fw supervisor run <flow> --json` (FW_PORT naming fwd's port) reaches the same route and
//      prints the same shape.
//   7. The same hand run on a real engine path: a second fwd with no FW_VENDOR, so the cycle takes
//      the flow's own engine (Codex, ChatGPT sign-in) through the real Codex adapter. The `codex` on
//      its PATH is probes/flows/_codex-agent.mjs, which acts like Codex CLI and a careful agent:
//      it refuses outside a git repository, writes nothing without README.md and config.json in its
//      folder or when the prompt forbids drafts.json, and like Codex never claims an artifact. The
//      cycle must end drafted by codex with its drafts waiting for the Owner, and spend recorded.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  root,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/dispatch';
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
      res.on('end', () => ok({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return undefined;
  }
};

async function startFwd(home, env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' }) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim(), env: { ...env, FW_PORT: String(port) } };
}

async function rows(home, sql, ...params) {
  const db = await openDbReadonly(home);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// A `codex` on PATH that runs the probe's stand-in agent, and a CODEX_HOME that counts as signed in.
function codexStandIn(home) {
  const bin = join(home, 'probe-bin');
  const codexHome = join(home, 'probe-codex-home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'auth.json'), '{"probe":"stand-in sign-in, no token"}\n');
  const agent = join(root, 'probes', 'flows', '_codex-agent.mjs');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`);
  chmodSync(join(bin, 'codex'), 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, CODEX_HOME: codexHome };
}

const reports = async (home) =>
  (await rows(home, "SELECT body FROM status_reports WHERE kind = 'run' ORDER BY created_at")).map((r) =>
    JSON.parse(r.body),
  );

await probe(NAME, async () => {
  const home = freshHome('dispatch');
  try {
    const f = await startFwd(home);
    const flowStream = JSON.parse(readFileSync(join(root, 'flows', KEY, 'stream.json'), 'utf8'));
    const SID = flowStream.id;

    // ---- 1. turning the flow on registers its stream --------------------------------------------
    const en = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, f.token);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}: ${en.body.slice(0, 200)}`);
    const st = await rows(home, 'SELECT id, key, status FROM streams WHERE key = ?', KEY);
    if (st.length === 0) missing(`turning ${KEY} on registered no stream (streams has no key ${KEY})`);
    check(st.length === 1 && st[0].id === SID, `streams rows for ${KEY}: ${JSON.stringify(st)}`);
    check(st[0].status === 'active', `the ${KEY} stream is ${st[0].status}, want active`);
    const created = await rows(home, "SELECT count(*) AS n FROM events WHERE type = 'stream.created' AND stream_id = ?", SID);
    check(Number(created[0].n) === 1, `stream.created events for ${SID}: ${created[0].n}, want 1`);

    // ---- 2. running by hand needs the CLI token ---------------------------------------------------
    const anon = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/run`, null);
    if (anon.status === 404) missing(`POST /v1/supervisor/flows/${KEY}/run answered 404 (no run route)`);
    check(anon.status === 401, `running ${KEY} without a token answered ${anon.status}, want 401`);
    const fired0 = await rows(home, "SELECT count(*) AS n FROM events WHERE type = 'stream.fired' AND stream_id = ?", SID);
    check(Number(fired0[0].n) === 0, 'a request without a token fired the stream');

    // ---- 3. with the token, the fire is fired and one cycle runs ---------------------------------
    const run = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/run`, f.token);
    check(run.status === 200, `running ${KEY} answered ${run.status}: ${run.body.slice(0, 200)}`);
    const rd = json(run)?.data;
    check(rd?.outcome === 'fired', `running ${KEY} by hand: outcome ${rd?.outcome} (${rd?.reason ?? ''}), want fired`);
    check(typeof rd.fire_id === 'string', 'the run answer has no fire_id');
    const fired = (
      await rows(home, "SELECT payload FROM events WHERE type = 'stream.fired' AND stream_id = ?", SID)
    ).map((r) => JSON.parse(r.payload));
    check(
      fired.length === 1 && fired[0].trigger === 'manual' && fired[0].outcome === 'fired' && fired[0].fire_id === rd.fire_id,
      `stream.fired for the hand run: ${JSON.stringify(fired)}`,
    );
    let rep;
    await waitFor(
      async () => {
        rep = (await reports(home)).find((b) => b.fire_id === rd.fire_id);
        return rep !== undefined;
      },
      { timeoutMs: 30000, everyMs: 250, what: 'the cycle to write its run report' },
    );
    check(
      rep.stream_id === SID && rep.adapter === 'fake' && rep.outcome === 'drafted' && rep.drafts >= 1,
      `the run report: ${JSON.stringify(rep)}`,
    );
    const dir = join(home, 'flows', KEY, 'drafts');
    const files = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : [];
    check(files.length === rep.drafts, `draft files: ${files.length}, the report says ${rep.drafts}`);
    for (const x of files) {
      const d = JSON.parse(readFileSync(join(dir, x), 'utf8'));
      check(
        d.flow === KEY && d.fire_id === rd.fire_id && typeof d.body === 'string' && d.body.length > 0,
        `draft ${x}: ${JSON.stringify(d).slice(0, 200)}`,
      );
      check(d.status === 'waiting_for_owner', `draft ${x} at Draft is ${d.status}, want waiting_for_owner`);
    }
    const spend = await rows(home, 'SELECT count(*) AS n, coalesce(sum(usd), 0) AS usd FROM spend_entries WHERE stream_id = ?', SID);
    check(Number(spend[0].n) >= 1 && Number(spend[0].usd) > 0, `spend for ${SID}: ${JSON.stringify(spend[0])}`);
    const sv = json(await http(f.port, 'GET', '/v1/supervisor', f.token))?.data;
    const spent = sv?.flows?.find((x) => x.key === KEY)?.budget?.spent_usd;
    check(typeof spent === 'number' && spent > 0, `GET /v1/supervisor shows ${KEY} spent ${spent}, want above 0`);

    // ---- 4. nothing handed off at Draft ------------------------------------------------------------
    check(!existsSync(join(home, 'outbox', KEY)) || readdirSync(join(home, 'outbox', KEY)).length === 0, 'a Draft flow wrote to the outbox');
    const db = await openDbReadonly(home);
    const queued = count(db, "SELECT count(*) FROM events WHERE type = 'notification.queued'");
    db.close();
    check(queued === 0, `notification.queued events at Draft: ${queued}, want 0`);

    // ---- 5. a flow that is off is held, and no cycle runs ----------------------------------------
    const off = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/disable`, f.token);
    check(off.status === 200, `disabling ${KEY} answered ${off.status}`);
    const before = (await reports(home)).length;
    const held = json(await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/run`, f.token))?.data;
    check(
      held?.outcome === 'held' && String(held.reason ?? '').startsWith('flow_disabled'),
      `running a flow that is off: ${JSON.stringify(held)}, want held by flow_disabled`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    check((await reports(home)).length === before, 'a held fire still ran a cycle');

    // ---- 6. the CLI reaches the same route ---------------------------------------------------------
    const cli = fwJson(['supervisor', 'run', KEY], { home, env: f.env });
    check(cli.status === 0 || cli.status === 1, `fw supervisor run exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    const cd = cli.json?.data ?? cli.json;
    check(
      cd?.outcome === 'held' && String(cd.reason ?? '').startsWith('flow_disabled') && typeof cd.fire_id === 'string',
      `fw supervisor run --json printed ${JSON.stringify(cli.json).slice(0, 200)}`,
    );

    // ---- 7. a real engine path: the flow's own Codex sign-in, through the Codex adapter -------------
    const home2 = freshHome('dispatch-codex');
    const g = await startFwd(home2, { FW_HOME: home2, ...codexStandIn(home2) });
    const en2 = await http(g.port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, g.token);
    check(en2.status === 200, `enabling ${KEY} on the Codex fwd answered ${en2.status}`);
    const run2 = json(await http(g.port, 'POST', `/v1/supervisor/flows/${KEY}/run`, g.token))?.data;
    check(run2?.outcome === 'fired', `running ${KEY} on the Codex fwd: ${JSON.stringify(run2)}, want fired`);
    let rep2;
    await waitFor(
      async () => {
        rep2 = (await reports(home2)).find((b) => b.fire_id === run2.fire_id);
        return rep2 !== undefined;
      },
      { timeoutMs: 60000, everyMs: 250, what: 'the Codex cycle to write its run report' },
    );
    check(
      rep2.stream_id === SID && rep2.adapter === 'codex' && rep2.outcome === 'drafted' && rep2.drafts >= 1,
      `the Codex run report: ${JSON.stringify(rep2).slice(0, 400)}`,
    );
    const dir2 = join(home2, 'flows', KEY, 'drafts');
    const files2 = existsSync(dir2) ? readdirSync(dir2).filter((x) => x.endsWith('.json')) : [];
    check(files2.length === rep2.drafts, `draft files after the Codex cycle: ${files2.length}, the report says ${rep2.drafts}`);
    for (const x of files2) {
      const d2 = JSON.parse(readFileSync(join(dir2, x), 'utf8'));
      check(
        d2.flow === KEY && d2.fire_id === run2.fire_id && d2.status === 'waiting_for_owner' && d2.body.length > 0,
        `the Codex draft ${x}: ${JSON.stringify(d2).slice(0, 200)}`,
      );
    }
    const spend2 = await rows(home2, 'SELECT count(*) AS n FROM spend_entries WHERE stream_id = ?', SID);
    check(Number(spend2[0].n) >= 1, `spend rows for the Codex cycle: ${spend2[0].n}, want at least 1`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
