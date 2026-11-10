// Probe for FW-C-033 (the Supervisor): `pnpm probe flows/supervisor`. Tier 0.
// Surfaces: the daemon fwd (one node process on a fresh FW_HOME), GET /v1/supervisor and the Owner
// controls under /v1/supervisor with the CLI token fwd prints, the database (read-only, except one
// step that engages the kill switch directly), and `fw supervisor status --json`.
//
// Proves, in order:
//   1. A fresh fwd lists every flow that ships a stream.json under flows/. Each flow is either ready
//      (no gate) or held by exactly one gate from the closed list fwd publishes, and a shipped flow
//      starts held by flow_disabled.
//   2. The Owner controls need the CLI token: without it, enabling a flow answers 401.
//   3. Enabling local-saturation with the CLI token frees it from flow_disabled (a fresh fwd has
//      nothing due, so it is then held by not_due) and writes a system.config_changed event that
//      names the flow.
//   4. With the period's dollar cap used up, the enabled flow is held by budget.
//   5. Pausing the Supervisor holds every flow by supervisor_paused; resuming frees them again.
//   6. With the kill switch engaged, every flow is held by kill_switch, even while paused.
//   7. `fw supervisor status --json` prints the same flows and gates as the API.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  openDbAsAttacker,
  openDbReadonly,
  probe,
  root,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/supervisor';
const KEY = 'local-saturation';
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

function http(port, method, path, token) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (method === 'POST') headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => ok({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (method === 'POST') req.write('{}');
    req.end();
  });
}

async function startFwd(home) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function supervisor(f) {
  const r = await http(f.port, 'GET', '/v1/supervisor', f.token);
  if (r.status === 404) missing('GET /v1/supervisor answered 404 (no Supervisor route)');
  check(r.status === 200, `GET /v1/supervisor answered ${r.status}: ${r.body.slice(0, 200)}`);
  const v = JSON.parse(r.body).data;
  check(Array.isArray(v?.gates) && v.gates.length > 0, 'GET /v1/supervisor does not publish its closed list of gates');
  check(Array.isArray(v.flows), 'GET /v1/supervisor has no flows list');
  for (const fl of v.flows) {
    check(['ready', 'held', 'running'].includes(fl.state), `flow ${fl.key} has state ${fl.state}`);
    if (fl.state === 'held') check(v.gates.includes(fl.gate), `flow ${fl.key} is held by ${fl.gate}, which is not in the gate list`);
    else check(fl.gate === null, `flow ${fl.key} is ${fl.state} but names gate ${fl.gate}`);
  }
  return v;
}

async function post(f, path, token = f.token) {
  const r = await http(f.port, 'POST', path, token);
  if (token) check(r.status === 200, `POST ${path} answered ${r.status}: ${r.body.slice(0, 200)}`);
  return r;
}

const gateOf = (v, key) => v.flows.find((x) => x.key === key)?.gate;

await probe(NAME, async () => {
  const shipped = readdirSync(join(root, 'flows'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, 'flows', e.name, 'stream.json')))
    .map((e) => e.name)
    .sort();
  check(shipped.includes(KEY), `flows/${KEY}/stream.json is missing`);
  const cap = JSON.parse(readFileSync(join(root, 'flows', KEY, 'stream.json'), 'utf8')).budget?.caps?.max_usd;
  check(cap > 0, `flows/${KEY}/stream.json has no dollar cap`);

  const home = freshHome('supervisor');
  try {
    // ---- 1. every shipped flow, held by flow_disabled --------------------------------------
    const f = await startFwd(home);
    let v = await supervisor(f);
    const listed = v.flows.map((x) => x.key).sort();
    check(JSON.stringify(listed) === JSON.stringify(shipped), `flows listed ${listed.join(', ')}; shipped ${shipped.join(', ')}`);
    for (const k of shipped) check(gateOf(v, k) === 'flow_disabled', `fresh flow ${k} is held by ${gateOf(v, k)}, want flow_disabled`);
    check(v.kill_switch === false && v.paused === false, 'a fresh Supervisor reports the kill switch or a pause');

    // ---- 2. Owner controls need the CLI token ----------------------------------------------
    const anon = await post(f, `/v1/supervisor/flows/${KEY}/enable`, null);
    check(anon.status === 401, `enabling a flow without a token answered ${anon.status}, want 401`);
    v = await supervisor(f);
    check(gateOf(v, KEY) === 'flow_disabled', 'a request without a token enabled the flow');

    // ---- 3. enable -> not_due, with an event -----------------------------------------------
    await post(f, `/v1/supervisor/flows/${KEY}/enable`);
    v = await supervisor(f);
    check(gateOf(v, KEY) === 'not_due', `enabled fresh flow is held by ${gateOf(v, KEY)}, want not_due`);
    let db = await openDbReadonly(home);
    const changes = () =>
      count(db, "SELECT count(*) FROM events WHERE type = 'system.config_changed' AND payload LIKE ?", `%${KEY}%`);
    check(changes() >= 1, `enabling ${KEY} wrote no system.config_changed event naming it`);
    db.close();

    // ---- 4. cap used up -> budget ---------------------------------------------------------
    const dir = join(home, 'flows', KEY);
    mkdirSync(dir, { recursive: true });
    const spent = { period_start: new Date().toISOString(), usd: cap, turns: 0 };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ spend: spent }));
    v = await supervisor(f);
    check(gateOf(v, KEY) === 'budget', `flow with its cap used up is held by ${gateOf(v, KEY)}, want budget`);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ spend: { ...spent, usd: 0 } }));

    // ---- 5. pause and resume ---------------------------------------------------------------
    await post(f, '/v1/supervisor/pause');
    v = await supervisor(f);
    check(v.paused === true, 'the Supervisor does not report the pause');
    for (const k of shipped) check(gateOf(v, k) === 'supervisor_paused', `paused: flow ${k} is held by ${gateOf(v, k)}`);
    await post(f, '/v1/supervisor/resume');
    v = await supervisor(f);
    check(gateOf(v, KEY) === 'not_due', `after resume ${KEY} is held by ${gateOf(v, KEY)}, want not_due`);

    // ---- 6. kill switch beats everything ---------------------------------------------------
    await post(f, '/v1/supervisor/pause');
    db = await openDbAsAttacker(home);
    db.prepare(
      "INSERT INTO settings (key, value, updated_by) VALUES ('kill_switch', ?, 'own_probe') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify({ engaged: true, reason: 'probe' }));
    db.close();
    v = await supervisor(f);
    check(v.kill_switch === true, 'the Supervisor does not report the engaged kill switch');
    for (const k of shipped) check(gateOf(v, k) === 'kill_switch', `kill switch: flow ${k} is held by ${gateOf(v, k)}`);

    // ---- 7. the CLI agrees -----------------------------------------------------------------
    const cli = fwJson(['supervisor', 'status'], { home });
    check(cli.status === 0, `fw supervisor status --json exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    const cliFlows = cli.json?.flows;
    check(Array.isArray(cliFlows), 'fw supervisor status --json printed no flows');
    for (const k of shipped)
      check(
        cliFlows.find((x) => x.key === k)?.gate === gateOf(v, k),
        `fw supervisor status says ${k} is held by ${cliFlows.find((x) => x.key === k)?.gate}, the API says ${gateOf(v, k)}`,
      );
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
