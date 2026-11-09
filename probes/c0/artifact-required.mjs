// Probe c0/artifact-required (WS-P0-039; backlog verify_probe kernel/artifact-required).
// Surface: fw run start with the fake vendor's fabricated_claim scenario (it reports success and a
// pull_request URL that does not exist) in a fixture project; then the database.
// Acceptance:
//   - a run with claimed success and no PR does not advance the row to done or merging: the row
//     stays at or before verifying, and a flagged event (run.claim_mismatch) is recorded
//   - the PR pointer is re-fetched from the git host and the head SHA compared: no kernel-verified
//     pull_request artifact exists for the run, and the run is not succeeded
//   - the fabricated PR URL case is covered (this fixture)
import { check, count, fixtureProject, freshHome, fw, openDbReadonly, pipelineEnv, probe } from './_lib.mjs';

await probe('c0/artifact-required', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-905', scenario: 'fabricated_claim' });
  const home = freshHome('artifact');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  check(fw(['ledger', 'ready', 'FW-C-905', '--json'], o).status === 0, 'fw ledger ready FW-C-905 failed');
  const run = fw(['run', 'start', 'FW-C-905', '--json'], o);
  check(run.status !== 0, 'fw run start reported success for a run whose only artifact is a fabricated PR URL');

  const db = await openDbReadonly(home);
  const r = db.prepare('SELECT * FROM runs ORDER BY queued_at DESC, rowid DESC LIMIT 1').get();
  check(r, 'no runs row: the fabricated claim was refused before the run was recorded (it must be recorded)');
  check(r.status !== 'succeeded', 'a run with a fabricated PR claim is succeeded');
  check(['claim_mismatch', 'no_artifact'].includes(r.failure_class), `failure_class is ${r.failure_class}, want claim_mismatch or no_artifact`);
  check(
    count(db, "SELECT count(*) FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request' AND verified_by_kernel = 1", r.id) === 0,
    'the fabricated PR was marked kernel-verified',
  );
  check(count(db, "SELECT count(*) FROM events WHERE type = 'run.claim_mismatch' AND run_id = ?", r.id) >= 1, 'no run.claim_mismatch event');
  const row = db.prepare("SELECT status FROM ledger_rows WHERE title LIKE '%FW-C-905%'").get();
  check(!['done', 'merging', 'watching', 'awaiting_approval'].includes(row?.status), `the row advanced to ${row?.status}`);
  db.close();
});
