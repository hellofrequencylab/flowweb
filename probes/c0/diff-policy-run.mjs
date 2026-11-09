// Probe c0/diff-policy-run (WS-P0-041 pipeline stage 7; KICKOFF Prompt 5 line for c0/diff-policy).
// KICKOFF names this check c0/diff-policy, but WS-P0-035 (the pure diff-policy function, backlog
// policy/diff-policy) cannot depend on the pipeline, so the run-level check lives here.
// Surface: `fw run start <ID> --adapter fake --scenario forbidden_path --json` (the fake writes
// CODEOWNERS and a file under probes/) in a fixture project; the local bare remote; the database.
// Acceptance:
//   - a run touching CODEOWNERS or a probe file fails, and the diff-policy violation is named
//     (policy.diff_policy_failed and policy.tamper_tripwire_fired name both paths)
//   - the branch is quarantined: the run branch is renamed fw/quarantine/<run_id> in the checkout,
//     nothing is pushed (no fw/ branch on the remote), no PR exists, no PR artifact is recorded,
//     and the quarantine is on the run's failure event. Run branches are fw/<row>/<run>, not
//     row/<ID> (decision 8).
import { existsSync } from 'node:fs';
import {
  branches,
  check,
  count,
  fixtureProject,
  fw,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  rowStatusOf,
} from './_lib.mjs';

await probe('c0/diff-policy-run', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-904', scenario: 'forbidden_path' });
  const home = pipelineHome('dprun');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  const run = fw(['run', 'start', 'FW-C-904', '--adapter', 'fake', '--scenario', 'forbidden_path', '--json'], o);
  check(run.status !== 0, 'a run that touched CODEOWNERS and probes/ exited 0');
  const report = JSON.parse(run.stdout);
  check(/diff policy|tier0|forbidden/i.test(report.reason ?? ''), `the refusal does not name the diff-policy violation: ${report.reason}`);

  check(report.branch === `fw/quarantine/${report.run_id}`, `the run branch is ${report.branch}, want fw/quarantine/${report.run_id}`);
  check(branches(proj.work, 'fw/quarantine/').includes(report.branch), 'the quarantine branch does not exist in the checkout');
  check(branches(proj.work, `fw/FW-C-904/`).length === 0, 'the run branch still exists under its review name');
  check(branches(proj.remote, 'fw/').length === 0, `a branch was pushed to the remote: ${branches(proj.remote, 'fw/').join(', ')}`);
  check(branches(proj.remote, 'row/').length === 0, 'a row/ branch was pushed to the remote');
  check(!existsSync(`${proj.remote}.prs`), 'a pull request was opened');

  const db = await openDbReadonly(home);
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(report.run_id);
  check(r?.status === 'failed', `run status is ${r?.status}, want failed`);
  check(count(db, "SELECT count(*) FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request'", r.id) === 0, 'a PR artifact exists');
  const ev = (type) => db.prepare('SELECT payload FROM events WHERE run_id = ? AND type = ?').get(r.id, type)?.payload ?? '';
  for (const type of ['policy.diff_policy_failed', 'policy.tamper_tripwire_fired']) {
    const p = ev(type);
    check(p, `no ${type} event for the run`);
    check(p.includes('CODEOWNERS') && p.includes('probes/'), `${type} does not name CODEOWNERS and the probes/ file`);
  }
  check(/quarantin/i.test(ev('run.failed')), 'the run.failed event does not record the quarantine');
  check(rowStatusOf(db, 'FW-C-904') === 'ready', `the row is ${rowStatusOf(db, 'FW-C-904')} after the failed run, want ready`);
  db.close();
});
