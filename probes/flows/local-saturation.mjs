// Probe for FW-C-031 (local saturation marketing flow): `pnpm probe flows/local-saturation`. Tier 0.
// Surfaces: the shipped definition in flows/local-saturation/, the daemon fwd (started as one node
// process on a fresh FW_HOME), and GET /v1/flows/local-saturation with the CLI token fwd prints.
//
// Proves, in order:
//   1. flows/local-saturation/stream.json and config.json exist. The stream starts disabled at tier L1
//      (draft only), its human gate is the Owner, and every channel's action class is gated.
//   2. A fresh fwd serves the flow: ring 0 is the seed alone and open, ring 1 is closed, the next
//      move is keep_working, and the budget shows the stream's caps.
//   3. With ring 0 saturated and held for hold_cycles (state.json in $FW_HOME), the next move is a
//      proposal to open ring 1 naming ring 1's areas, and the open ring is still 0.
//   4. With the period's dollar cap used up, the next move is paused_budget, even when ring 0 is
//      saturated.
//   5. Any other flow key answers 404.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  check,
  DAEMON_BIN,
  freshHome,
  killAndWait,
  missing,
  probe,
  requireFile,
  root,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/local-saturation';
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

function httpGet(port, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${token}` }, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => ok({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
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

async function getFlow(f, key = 'local-saturation') {
  const r = await httpGet(f.port, `/v1/flows/${key}`, f.token);
  if (key === 'local-saturation' && r.status === 404) missing(`GET /v1/flows/${key} answered 404 (no flows route)`);
  return r;
}

const full = { targets_known: 20, targets_reached: 20, touches_28d: 40, new_members_28d: 100000 };

await probe(NAME, async () => {
  // ---- 1. shipped definition ---------------------------------------------------------------
  requireFile('flows/local-saturation/stream.json', 'the flow stream definition');
  requireFile('flows/local-saturation/config.json', 'the flow config: areas, thresholds, channels');
  const stream = JSON.parse(readFileSync(join(root, 'flows/local-saturation/stream.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(root, 'flows/local-saturation/config.json'), 'utf8'));
  check(stream.enabled === false, 'stream.json must ship disabled');
  check(stream.default_tier === 'L1', `stream.json default_tier is ${stream.default_tier}, want L1 (draft only)`);
  check(stream.human_gate?.approver === 'owner', 'stream.json human_gate.approver is not owner');
  for (const c of cfg.channels ?? [])
    check(
      (stream.human_gate.gate_on ?? []).includes(c.action_class),
      `channel ${c.key} uses ${c.action_class}, which the human gate does not cover`,
    );
  check(stream.budget?.caps?.max_usd > 0, 'stream.json has no dollar cap');

  const home = freshHome('flow');
  try {
    // ---- 2. fresh fwd -------------------------------------------------------------------------
    let f = await startFwd(home);
    let r = await getFlow(f);
    check(r.status === 200, `GET /v1/flows/local-saturation answered ${r.status}: ${r.body.slice(0, 200)}`);
    let v = JSON.parse(r.body).data;
    check(v.rings?.[0]?.areas?.length === 1 && v.rings[0].areas[0].id === cfg.seed_area_id, 'ring 0 is not the seed alone');
    check(v.rings[0].open === true && v.rings[1]?.open === false, 'a fresh flow must have ring 0 open and ring 1 closed');
    check(v.decision?.kind === 'keep_working', `fresh decision is ${v.decision?.kind}, want keep_working`);
    check(v.budget?.max_usd === stream.budget.caps.max_usd, 'budget.max_usd does not match the stream cap');
    const ring1 = v.rings[1].areas.map((a) => a.id);

    // ---- 3. saturated seed proposes ring 1 -----------------------------------------------------
    await killAndWait(f.d, 'SIGTERM');
    const dir = join(home, 'flows', 'local-saturation');
    mkdirSync(dir, { recursive: true });
    const base = { open_ring: 0, awaiting_owner: {}, signals: { [cfg.seed_area_id]: full } };
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ ...base, cycles_at_threshold: cfg.saturation.hold_cycles, spend: { period_start: new Date().toISOString(), usd: 0, turns: 0 } }),
    );
    f = await startFwd(home);
    v = JSON.parse((await getFlow(f)).body).data;
    check(v.decision?.kind === 'propose_expansion', `saturated seed decision is ${v.decision?.kind}, want propose_expansion`);
    check(JSON.stringify(v.decision.area_ids) === JSON.stringify(ring1), 'the proposal does not name ring 1 areas');
    check(v.open_ring === 0, 'the flow opened a ring by itself');

    // ---- 4. cap used up pauses -----------------------------------------------------------------
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ ...base, cycles_at_threshold: 9, spend: { period_start: new Date().toISOString(), usd: stream.budget.caps.max_usd, turns: 0 } }),
    );
    v = JSON.parse((await getFlow(f)).body).data;
    check(v.decision?.kind === 'paused_budget', `decision with the cap used up is ${v.decision?.kind}, want paused_budget`);

    // ---- 5. unknown key -----------------------------------------------------------------------
    r = await getFlow(f, 'not-a-flow');
    check(r.status === 404, `GET /v1/flows/not-a-flow answered ${r.status}, want 404`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
