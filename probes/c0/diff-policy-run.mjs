// Probe c0/diff-policy-run (WS-P0-041 pipeline stage 5; KICKOFF Prompt 5 line for c0/diff-policy).
// KICKOFF names this check c0/diff-policy, but WS-P0-035 (the pure diff-policy function, backlog
// policy/diff-policy) cannot depend on the pipeline, so the run-level check lives here.
// Surface: fw run start with the fake vendor's forbidden_path scenario (writes CODEOWNERS and a file
// under probes/) in a fixture project; the local bare remote; the database.
// Acceptance:
//   - a run touching CODEOWNERS or a probe file fails (diff-policy violation named)
//   - the branch is quarantined: not pushed as row/<ID> for review, no PR artifact, and a
//     quarantine is recorded in an event
import { spawnSync } from 'node:child_process';
import { check, count, fixtureProject, freshHome, fw, openDbReadonly, pipelineEnv, probe } from './_lib.mjs';

await probe('c0/diff-policy-run', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-904', scenario: 'forbidden_path' });
  const home = freshHome('dprun');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  check(fw(['ledger', 'ready', 'FW-C-904', '--json'], o).status === 0, 'fw ledger ready FW-C-904 failed');
  const run = fw(['run', 'start', 'FW-C-904', '--json'], o);
  check(run.status !== 0, 'a run that touched CODEOWNERS and probes/ exited 0');
  check(/forbidden_path|tier ?0|diff[- ]policy/i.test(run.stdout + run.stderr), 'the refusal does not name the diff-policy violation');

  const remoteBranch = spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/row/FW-C-904'], { cwd: proj.remote });
  check(remoteBranch.status !== 0, 'the violating branch was pushed as row/FW-C-904 for review');

  const db = await openDbReadonly(home);
  const r = db.prepare('SELECT * FROM runs ORDER BY queued_at DESC, rowid DESC LIMIT 1').get();
  check(r && r.status === 'failed', `run status is ${r?.status}, want failed`);
  check(count(db, "SELECT count(*) FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request'", r.id) === 0, 'a PR artifact exists');
  const q = db
    .prepare('SELECT type, payload FROM events WHERE run_id = ? OR payload LIKE ?')
    .all(r.id, '%FW-C-904%')
    .filter((e) => /quarantin/i.test(e.payload) || /quarantin/i.test(e.type));
  check(q.length >= 1, 'no event records that the branch was quarantined');
  db.close();
});
