// A real fwd (startDaemon) that, once serving, starts a queued run the way the supervisor does
// (queued -> starting -> running under its lease, run.started appended) and then prints RUNNING.
// The crash test kill -9s this process while the run is running.
import { startDaemon } from '../../src/daemon.ts';

const [fwHome, runId] = process.argv.slice(2);
if (!fwHome || !runId) throw new Error('usage: crash-child <fwHome> <runId>');

const d = await startDaemon({ fwHome, port: 0, devNoAuth: true, log: () => {} });
d.writer.transaction((w) => {
  w.run("UPDATE runs SET status = 'starting' WHERE id = ? AND status = 'queued'", [runId]);
  w.run(
    "UPDATE runs SET status = 'running', session_id = 'ses-crash', started_at = ? WHERE id = ? AND status = 'starting'",
    [new Date().toISOString(), runId],
  );
  w.appendEvent({
    type: 'run.started',
    actor_kind: 'system',
    actor_id: 'fwd.supervisor',
    run_id: runId,
    idempotency_key: `${runId}:started`,
    payload: { run_id: runId, session_id: 'ses-crash', sandbox_level: 'best_effort' },
  });
});
process.stdout.write(`RUNNING ${d.port}\n`);
// Stay alive (the server keeps the loop busy) until killed.
