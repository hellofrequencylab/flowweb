// Probe c0/orphan-recovery (KICKOFF Prompt 5; no C0 backlog row owns it: the daemon is WS-P1-001 and
// the reconciler WS-P1-006, both C1. See probes/c0/README.md, "Conflicts").
// In C0 the run pipeline runs inside `fw run start` and fwd refuses to share the writer (decision
// 31), so "kill -9 the daemon mid-run" is played as: kill -9 the process running the pipeline (the
// CLI) mid-run, then start fwd, whose reconciler settles the orphan on start.
// Surfaces: `fw run start <ID> --adapter fake --scenario hang` as a child process, the daemon fwd
// (tsx packages/daemon/src/bin.ts), the database, the process table (Linux /proc, ps and lsof elsewhere).
// Acceptance:
//   - after the kill and a restart the orphaned run is failed (failure_class killed), its lease is
//     released, its vendor process group is gone, the row is back to ready, and the run is never
//     started or failed twice (a second restart reconciles nothing)
//   - (WS-P0-029) while the vendor runs, the credential is not in its argv
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_BIN,
  check,
  count,
  DAEMON_BIN,
  fakeSecret,
  fixtureProject,
  fw,
  groupAlive,
  killAndWait,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  processArgv,
  processCwds,
  processTable,
  rowStatusOf,
  sleep,
  spawnTs,
  waitFor,
} from './_lib.mjs';

const kids = [];

/** "pid:state:cwd" of every process in the group, for the failure message. */
function groupMembers(pgid) {
  const cwds = processCwds();
  const out = processTable()
    .filter((p) => p.pgid === pgid)
    .map((p) => `${p.pid}:${p.zombie ? 'Z' : 'live'}:${cwds.get(p.pid) ?? '?'}`);
  return out.join(' ') || 'none';
}
function stopAll() {
  for (const c of kids) {
    for (const pid of [-c.pid, c.pid]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

async function startFwd(home, env) {
  // One node process (tsx as an import hook), so killing it leaves no forked child holding fwd.lock.
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', '0'], { env: { ...env, FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().split('\n')[0]}`);
  return d;
}

await probe('c0/orphan-recovery', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-906', scenario: 'hang' });
  const home = pipelineHome('orphan');
  const secret = fakeSecret('anthropic');
  mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'creds', 'crd_fake0001'), `${secret}\n`, { mode: 0o600 });
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env };
  let pgid;
  try {
    check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');

    // One node process (tsx as an import hook, not the tsx wrapper), so SIGKILL hits the pipeline itself.
    const cli = spawnTs(CLI_BIN, ['run', 'start', 'FW-C-906', '--adapter', 'fake', '--scenario', 'hang', '--json'], {
      cwd: proj.work,
      env: { ...env, FW_HOME: home },
    });
    kids.push(cli);
    const started = await waitFor(
      async () => {
        try {
          const db = await openDbReadonly(home);
          const e = db.prepare("SELECT run_id, payload FROM events WHERE type = 'run.started'").get();
          db.close();
          return e;
        } catch {
          return null;
        }
      },
      { timeoutMs: 60000, what: 'run.started of the hanging run' },
    );
    const runId = started.run_id;
    pgid = JSON.parse(started.payload).vendor_pgid;
    check(Number.isInteger(pgid), 'run.started does not record the vendor process group');
    check(groupAlive(pgid), 'the vendor is not running');
    const argv = processArgv(pgid);
    check(!argv.includes(secret), 'the credential is in the vendor argv');

    await killAndWait(cli);
    let db = await openDbReadonly(home);
    check(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)?.status === 'running', 'the run is not left running by the kill');
    db.close();

    const fwd = await startFwd(home, env);
    const after = await waitFor(
      async () => {
        const d = await openDbReadonly(home);
        const r = d.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        d.close();
        return r.status !== 'running' ? r : null;
      },
      { timeoutMs: 30000, what: 'the reconciler to settle the orphaned run' },
    );
    check(after.status === 'failed' && after.failure_class === 'killed', `the orphan is ${after.status}/${after.failure_class}, want failed/killed`);
    const rec = async () => {
      const d = await openDbReadonly(home);
      const e = d.prepare("SELECT payload FROM events WHERE type = 'reconciler.completed' ORDER BY seq DESC").get();
      d.close();
      return e?.payload ?? 'no reconciler.completed event';
    };
    try {
      await waitFor(() => !groupAlive(pgid), { timeoutMs: 10000, what: 'the vendor process group to be gone' });
    } catch (e) {
      throw new Error(`${e.message}; the reconciler reported ${await rec()}; vendor pgid ${pgid}, group members (pid:state:cwd): ${groupMembers(pgid)}`);
    }
    await killAndWait(fwd);

    await startFwd(home, env); // a second restart must find nothing to do
    await sleep(1000);
    db = await openDbReadonly(home);
    const leases = db.prepare('SELECT status FROM leases WHERE run_id = ?').all(runId).map((l) => l.status);
    check(leases.length === 1 && leases[0] === 'released', `the orphan's lease is ${leases.join(',')}, want released`);
    check(count(db, "SELECT count(*) FROM events WHERE type = 'run.started' AND run_id = ?", runId) === 1, 'the orphaned run was started twice');
    check(count(db, "SELECT count(*) FROM events WHERE type = 'run.failed' AND run_id = ?", runId) === 1, 'the orphaned run was failed more than once');
    check(count(db, "SELECT count(*) FROM runs WHERE status IN ('queued','starting','running')") === 0, 'a run is live again after the restarts (double execution)');
    check(count(db, "SELECT count(*) FROM events WHERE type = 'reconciler.completed'") === 2, 'fwd did not reconcile on each start');
    check(rowStatusOf(db, 'FW-C-906') === 'ready', `the row is ${rowStatusOf(db, 'FW-C-906')} after recovery, want ready`);
    db.close();
  } finally {
    stopAll();
    if (pgid) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {}
    }
  }
});
