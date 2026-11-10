// Probe for FW-C-035 (the flow dial): `pnpm probe flows/dial`. Tier 0.
// Surfaces: the daemon fwd (one node process on a fresh FW_HOME), GET /v1/supervisor and
// POST /v1/supervisor/flows/{key}/dial with the CLI token fwd prints, the config override under
// $FW_HOME/flows/<key>/config.json, the database (read-only, except one step that engages the kill
// switch directly), and `fw supervisor status --json`.
//
// Proves, in order:
//   1. Every flow GET /v1/supervisor lists has a dial, and a fresh flow is at draft.
//   2. Setting the dial without the CLI token answers 401, and the dial stays at draft.
//   3. Setting copilot with the token works and writes a system.config_changed event naming the flow.
//   4. Setting autopilot without a confirm hash, or with a wrong one, answers 409 with the current
//      hash and leaves the flow at copilot. With that hash the flow is at autopilot, and it is not
//      held by cap_required or dial_unapproved.
//   5. Adding a channel to the flow's config (the $FW_HOME override) holds it by dial_unapproved.
//      Confirming the new hash, which differs from the old one, frees it again.
//   6. With the kill switch engaged, the flow at autopilot is held by kill_switch.
//   7. `fw supervisor status --json` prints the same dial for every flow as the API.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const NAME = 'flows/dial';
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

function http(port, method, path, token, body) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 5000 }, (res) => {
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
  check(r.status === 200, `GET /v1/supervisor answered ${r.status}: ${r.body.slice(0, 200)}`);
  const v = JSON.parse(r.body).data;
  check(Array.isArray(v?.flows) && v.flows.length > 0, 'GET /v1/supervisor lists no flows');
  return v;
}

const flowOf = (v, key) => v.flows.find((x) => x.key === key);

async function setDial(f, stop, extra = {}, token = f.token) {
  const r = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/dial`, token, { stop, ...extra });
  if (r.status === 404) missing(`POST /v1/supervisor/flows/${KEY}/dial answered 404 (no dial route)`);
  return r;
}

/** The confirm hash fwd names in a 409, wherever the error envelope puts it. */
function confirmHashOf(r) {
  let e;
  try {
    e = JSON.parse(r.body)?.error;
  } catch {
    e = undefined;
  }
  const h = e?.confirm_hash ?? e?.details?.confirm_hash;
  check(typeof h === 'string' && h.length >= 16, `a 409 for autopilot carried no confirm_hash: ${r.body.slice(0, 200)}`);
  return h;
}

await probe(NAME, async () => {
  const home = freshHome('dial');
  try {
    // ---- 1. every flow has a dial, and starts at draft ------------------------------------
    const f = await startFwd(home);
    let v = await supervisor(f);
    for (const fl of v.flows) {
      if (fl.dial === undefined) missing(`GET /v1/supervisor shows no dial for ${fl.key}`);
      check(fl.dial === 'draft', `fresh flow ${fl.key} is at ${fl.dial}, want draft`);
    }

    // ---- 2. the dial needs the CLI token ----------------------------------------------------
    const anon = await setDial(f, 'copilot', {}, null);
    check(anon.status === 401, `setting the dial without a token answered ${anon.status}, want 401`);
    v = await supervisor(f);
    check(flowOf(v, KEY).dial === 'draft', 'a request without a token moved the dial');

    // ---- 3. copilot, with an event -----------------------------------------------------------
    const cp = await setDial(f, 'copilot');
    check(cp.status === 200, `setting copilot answered ${cp.status}: ${cp.body.slice(0, 200)}`);
    v = await supervisor(f);
    check(flowOf(v, KEY).dial === 'copilot', `after setting copilot the dial is ${flowOf(v, KEY).dial}`);
    let db = await openDbReadonly(home);
    const changes = count(
      db,
      "SELECT count(*) FROM events WHERE type = 'system.config_changed' AND payload LIKE ? AND payload LIKE ?",
      `%${KEY}%`,
      '%copilot%',
    );
    db.close();
    check(changes >= 1, 'setting copilot wrote no system.config_changed event naming the flow and the stop');

    // ---- 4. autopilot is bound to a confirm hash ---------------------------------------------
    const bare = await setDial(f, 'autopilot');
    check(bare.status === 409, `autopilot without a confirm hash answered ${bare.status}, want 409`);
    const hash1 = confirmHashOf(bare);
    const wrong = await setDial(f, 'autopilot', { confirm: '0'.repeat(hash1.length) });
    check(wrong.status === 409, `autopilot with a wrong confirm hash answered ${wrong.status}, want 409`);
    v = await supervisor(f);
    check(flowOf(v, KEY).dial === 'copilot', 'a refused autopilot request still moved the dial');
    const ok = await setDial(f, 'autopilot', { confirm: hash1 });
    check(ok.status === 200, `autopilot with the confirm hash answered ${ok.status}: ${ok.body.slice(0, 200)}`);
    v = await supervisor(f);
    check(flowOf(v, KEY).dial === 'autopilot', `after confirming, the dial is ${flowOf(v, KEY).dial}`);
    for (const g of ['cap_required', 'dial_unapproved'])
      check(flowOf(v, KEY).gate !== g, `a confirmed autopilot flow is held by ${g}`);

    // ---- 5. a new channel needs a new confirmation -------------------------------------------
    const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
    check(Array.isArray(cfg.channels), `flows/${KEY}/config.json has no channels list`);
    cfg.channels = [
      ...cfg.channels,
      { key: 'probe_channel', label: 'Probe channel', action_class: 'publish_external', placeholder: true },
    ];
    const dir = join(home, 'flows', KEY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    v = await supervisor(f);
    check(
      flowOf(v, KEY).gate === 'dial_unapproved',
      `after its channels changed the autopilot flow is held by ${flowOf(v, KEY).gate}, want dial_unapproved`,
    );
    const again = await setDial(f, 'autopilot');
    check(again.status === 409, `re-confirming without a hash answered ${again.status}, want 409`);
    const hash2 = confirmHashOf(again);
    check(hash2 !== hash1, 'the confirm hash did not change when the channel list changed');
    const ok2 = await setDial(f, 'autopilot', { confirm: hash2 });
    check(ok2.status === 200, `confirming the new hash answered ${ok2.status}: ${ok2.body.slice(0, 200)}`);
    v = await supervisor(f);
    check(flowOf(v, KEY).gate !== 'dial_unapproved', 'confirming the new hash did not free the flow');

    // ---- 6. the kill switch still holds an autopilot flow -----------------------------------
    db = await openDbAsAttacker(home);
    db.prepare(
      "INSERT INTO settings (key, value, updated_by) VALUES ('kill_switch', ?, 'own_probe') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify({ engaged: true, reason: 'probe' }));
    db.close();
    v = await supervisor(f);
    check(flowOf(v, KEY).gate === 'kill_switch', `kill switch: the autopilot flow is held by ${flowOf(v, KEY).gate}`);

    // ---- 7. the CLI agrees -------------------------------------------------------------------
    // FW_PORT names this probe's fwd, so another fwd on the default port (the Owner's own) is never asked.
    const cli = fwJson(['supervisor', 'status'], { home, env: { FW_PORT: String(f.port) } });
    check(cli.status === 0, `fw supervisor status --json exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    const cliFlows = cli.json?.flows;
    check(Array.isArray(cliFlows), 'fw supervisor status --json printed no flows');
    for (const fl of v.flows)
      check(
        cliFlows.find((x) => x.key === fl.key)?.dial === fl.dial,
        `fw supervisor status says ${fl.key} is at ${cliFlows.find((x) => x.key === fl.key)?.dial}, the API says ${fl.dial}`,
      );
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
