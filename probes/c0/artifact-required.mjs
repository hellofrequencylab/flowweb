// Probe c0/artifact-required (WS-P0-039; backlog verify_probe kernel/artifact-required).
// Surface: `fw run start <ID> --adapter fake --scenario fabricated_claim --json` (the fake reports
// success and a pull_request URL that does not exist, with no commit) in a fixture project with a
// local bare remote; then the remote and the database.
// Acceptance:
//   - a run with claimed success and no PR does not advance the row: it is not verifying, merging or
//     done afterwards (the pipeline returns it to ready), and a flagged event (run.claim_mismatch)
//     is recorded for the run
//   - the PR pointer is checked against the host, never trusted: no kernel-verified artifact exists
//     for the run, no pull request exists on the host, and the run is failed, not succeeded
//   - the fabricated PR URL case is covered (this fixture)
import { existsSync } from 'node:fs';
import { check, count, fixtureProject, fw, openDbReadonly, pipelineEnv, pipelineHome, probe, rowStatusOf } from './_lib.mjs';

await probe('c0/artifact-required', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-905', scenario: 'fabricated_claim' });
  const home = pipelineHome('artifact');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  const run = fw(['run', 'start', 'FW-C-905', '--adapter', 'fake', '--scenario', 'fabricated_claim', '--json'], o);
  check(run.status !== 0, 'fw run start reported success for a run whose only artifact is a fabricated PR URL');
  const report = JSON.parse(run.stdout);

  const db = await openDbReadonly(home);
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(report.run_id);
  check(r, 'no runs row: the fabricated claim must be recorded as a run, then refused');
  check(r.status === 'failed', `a run with a fabricated PR claim is ${r.status}, want failed`);
  check(['claim_mismatch', 'no_artifact'].includes(r.failure_class), `failure_class is ${r.failure_class}, want claim_mismatch or no_artifact`);
  check(
    count(db, 'SELECT count(*) FROM run_artifacts WHERE run_id = ? AND verified_by_kernel = 1', r.id) === 0,
    'an artifact of the fabricated run was marked kernel-verified',
  );
  check(count(db, "SELECT count(*) FROM events WHERE type = 'run.claim_mismatch' AND run_id = ?", r.id) >= 1, 'no run.claim_mismatch event for the run');
  check(count(db, "SELECT count(*) FROM events WHERE type = 'run.failed' AND run_id = ?", r.id) === 1, 'no single run.failed event for the run');
  const status = rowStatusOf(db, 'FW-C-905');
  check(!['verifying', 'merging', 'watching', 'done'].includes(status), `the row advanced to ${status}`);
  db.close();
  check(!existsSync(`${proj.remote}.prs`), 'a pull request was opened on the host for the fabricated run');
});
