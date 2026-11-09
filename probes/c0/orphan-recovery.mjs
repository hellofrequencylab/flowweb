// Probe c0/orphan-recovery (KICKOFF Prompt 5; no C0 backlog row owns it: the daemon is WS-P1-001 and
// the reconciler WS-P1-006, both C1. See probes/c0/README.md, "Conflicts").
// Surface: the daemon fwd (tsx packages/daemon/src/bin.ts), fw run start (client of the daemon),
// the database.
// Acceptance:
//   - kill -9 the daemon mid-run, restart it: the orphaned run is marked failed (or killed), its
//     lease is released, the vendor process is gone, and the run is not executed twice
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import {
  CLI_BIN,
  check,
  count,
  DAEMON_BIN,
  fixtureProject,
  freshHome,
  fw,
  missing,
  openDbReadonly,
  pipelineEnv,
  probe,
  sleep,
  spawnBg,
  TSX,
  waitFor,
} from './_lib.mjs';

function pidsInDir(dir) {
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readlinkSync(`/proc/${d}/cwd`).startsWith(dir)) out.push(Number(d));
    } catch {}
  }
  return out;
}

const kids = [];
function stopAll() {
  for (const c of kids) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {}
  }
}

await probe('c0/orphan-recovery', async () => {
  if (!existsSync(DAEMON_BIN)) missing('packages/daemon/src/bin.ts does not exist (daemon fwd, WS-P1-001)');
  const proj = fixtureProject({ rowId: 'FW-C-906', scenario: 'runaway' });
  const home = freshHome('orphan');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env };
  try {
    check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
    check(fw(['ledger', 'ready', 'FW-C-906', '--json'], o).status === 0, 'fw ledger ready FW-C-906 failed');

    const startDaemon = () => {
      const d = spawnBg(TSX, [DAEMON_BIN], { cwd: proj.work, env: { ...env, FW_HOME: home } });
      kids.push(d);
      return d;
    };
    let fwd = startDaemon();
    await waitFor(async () => {
      try {
        const db = await openDbReadonly(home);
        const n = count(db, "SELECT count(*) FROM events WHERE type = 'system.started'");
        db.close();
        return n >= 1;
      } catch {
        return false;
      }
    }, { timeoutMs: 30000, what: 'fwd to record system.started' });

    kids.push(spawnBg(TSX, [CLI_BIN, 'run', 'start', 'FW-C-906', '--json'], { cwd: proj.work, env: { ...env, FW_HOME: home } }));
    const run = await waitFor(async () => {
      const db = await openDbReadonly(home);
      const r = db.prepare("SELECT * FROM runs WHERE status = 'running' LIMIT 1").get();
      db.close();
      return r;
    }, { timeoutMs: 60000, what: 'a running run' });

    process.kill(fwd.pid, 'SIGKILL');
    await sleep(500);
    fwd = startDaemon();
    const after = await waitFor(async () => {
      const db = await openDbReadonly(home);
      const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
      db.close();
      return ['failed', 'killed'].includes(r.status) ? r : null;
    }, { timeoutMs: 30000, what: 'the reconciler to fail the orphaned run' });
    check(after.failure_class, 'the orphaned run has no failure_class');

    await sleep(3000);
    const db = await openDbReadonly(home);
    if (run.lease_id) {
      const lease = db.prepare('SELECT status, released_at FROM leases WHERE id = ?').get(run.lease_id);
      check(lease.status !== 'active', `the orphaned run's lease is still ${lease.status}`);
    } else {
      check(count(db, "SELECT count(*) FROM leases WHERE status = 'active'") === 0, 'an active lease survived the restart');
    }
    check(count(db, "SELECT count(*) FROM events WHERE type = 'run.started' AND run_id = ?", run.id) === 1, 'the orphaned run was started twice');
    check(count(db, "SELECT count(*) FROM runs WHERE status IN ('running','starting')") === 0, 'a run is running again after the restart (double execution)');
    db.close();
    if (run.workspace_path) {
      const left = pidsInDir(run.workspace_path);
      check(left.length === 0, `the orphaned vendor process is still alive: ${left.join(', ')}`);
    }
  } finally {
    stopAll();
  }
});
