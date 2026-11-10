// Probe for FW-C-012 (kill switch that works with the daemon down): `pnpm probe security/kill-switch`.
// Tier 0.
// probe-timeout-s: 300
// Surfaces: a real fwd on loopback (probes/lib/fwd.mjs) with the fake vendor and a local bare git host,
// the fw CLI (`fw ledger sync`, `fw run start`, `fw kill`), GET /v1/status, and the database (read-only,
// plus one direct write as an attacker to prove the release trigger).
// The surface this probe expects:
//   fw kill [--reason <text>] --json engages the kill switch. With fwd up it goes through
//     POST /v1/kill-switch; with fwd down it writes the database itself (settings('kill_switch')
//     engaged = 1, one system.kill_switch_engaged event). Exit 0 both ways.
//   fw kill release --json releases it as the Owner (Owner only, one system.kill_switch_released).
//   Engaging halts a running run within 2 s: the run is killed, no lease stays active, and the vendor
//   process group is gone.
//   fwd started while the switch is engaged refuses to dispatch: fw run start exits nonzero naming
//   kill_switch_engaged, no run row is added, and GET /v1/status reports kill.engaged true.
//
// Proves, in order:
//   1. A run of the fake vendor's hang scenario is halted within 2 s of fw kill, with no active lease.
//   2. A release written by a non-Owner identity is refused by the database; the Owner's release works.
//   3. With fwd stopped, fw kill still engages, and the next fwd start refuses to dispatch.
import {
  CLI_BIN,
  check,
  count,
  fixtureProject,
  fw,
  fwJson,
  killAndWait,
  missing,
  openDbAsAttacker,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';
import { api, freePort, startFwd } from '../lib/fwd.mjs';

const ROW = 'FW-C-974';

await probe('security/kill-switch', async () => {
  const proj = fixtureProject({ rowId: ROW, scenario: 'hang' });
  const home = pipelineHome('kill');
  const port = await freePort();
  const env = pipelineEnv({ FW_PORT: String(port) });
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  const q = async (sql, ...p) => {
    const db = await openDbReadonly(home);
    try {
      return count(db, sql, ...p);
    } finally {
      db.close();
    }
  };

  let fwd = await startFwd(home, { env, port });
  let runner;
  try {
    // 1. Halt a running run.
    runner = spawnTs(CLI_BIN, ['run', 'start', ROW, '--adapter', 'fake', '--scenario', 'hang', '--max-wall-clock-s', '240', '--json'], {
      cwd: proj.work,
      env: { FW_HOME: home, ...env },
    });
    await waitFor(async () => (await q("SELECT count(*) FROM runs WHERE status = 'running'")) === 1, {
      timeoutMs: 60000,
      what: 'the hang run to reach running',
    });
    const t0 = Date.now();
    const k = fw(['kill', '--reason', 'probe: halt the hang run', '--json'], o);
    if (k.status !== 0 && /unknown command|not found|"USAGE"/i.test(k.stdout + k.stderr)) missing('fw kill does not exist (row FW-C-012)');
    check(k.status === 0, `fw kill exited ${k.status}: ${(k.stdout + k.stderr).slice(0, 200)}`);
    await waitFor(
      async () =>
        (await q("SELECT count(*) FROM runs WHERE status = 'killed'")) === 1 &&
        (await q("SELECT count(*) FROM leases WHERE status = 'active'")) === 0,
      { timeoutMs: 5000, what: 'the run to be killed and its lease released' },
    );
    const ms = Date.now() - t0;
    check(ms <= 2000, `the run was halted ${ms} ms after fw kill, want at most 2000`);
    check((await q("SELECT count(*) FROM events WHERE type = 'system.kill_switch_engaged'")) === 1, 'want one system.kill_switch_engaged');
    await waitFor(() => runner.exitCode !== null, { timeoutMs: 15000, what: 'fw run start to return after the kill' });
    check(runner.exitCode !== 0, 'fw run start reported success for a killed run');

    // 2. Release: non-Owner refused by the database, Owner allowed.
    const attacker = await openDbAsAttacker(home);
    let refused = false;
    try {
      attacker
        .prepare("UPDATE settings SET value = json_set(value, '$.engaged', 0), updated_by = 'agt_probe' WHERE key = 'kill_switch'")
        .run();
    } catch (e) {
      refused = /only the Owner/i.test(String(e?.message));
    } finally {
      attacker.close();
    }
    check(refused, 'the database let a non-Owner identity release the kill switch');
    const rel = fwJson(['kill', 'release'], o);
    check(rel.status === 0, `fw kill release exited ${rel.status}: ${(rel.stdout + rel.stderr).slice(0, 200)}`);
    check((await q("SELECT count(*) FROM events WHERE type = 'system.kill_switch_released'")) === 1, 'want one system.kill_switch_released');

    // 3. Daemon down.
    await fwd.stop();
    fwd = null;
    const off = fw(['kill', '--reason', 'probe: daemon down', '--json'], o);
    check(off.status === 0, `fw kill with fwd stopped exited ${off.status}: ${(off.stdout + off.stderr).slice(0, 200)}`);
    check(
      (await q("SELECT count(*) FROM settings WHERE key = 'kill_switch' AND json_extract(value, '$.engaged') = 1")) === 1,
      'fw kill with fwd stopped did not engage the switch in the database',
    );
    check((await q("SELECT count(*) FROM events WHERE type = 'system.kill_switch_engaged'")) === 2, 'fw kill with fwd stopped recorded no event');
    fwd = await startFwd(home, { env, port });
    const st = await api(port, 'GET', '/v1/status', { auth: fwd.token });
    check(st.json?.data?.kill?.engaged === true, 'fwd started under an engaged switch does not report kill.engaged');
    const runsBefore = await q('SELECT count(*) FROM runs');
    const again = fw(['run', 'start', ROW, '--adapter', 'fake', '--scenario', 'success', '--json'], o);
    check(again.status !== 0, 'fwd dispatched a run while the kill switch was engaged');
    check(/kill_switch_engaged/.test(again.stdout + again.stderr), 'the refused dispatch does not name kill_switch_engaged');
    check((await q('SELECT count(*) FROM runs')) === runsBefore, 'a run row was added while the kill switch was engaged');
  } finally {
    if (runner) await killAndWait(runner);
    if (fwd) await fwd.stop();
  }
});
