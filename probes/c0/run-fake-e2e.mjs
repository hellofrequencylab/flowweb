// Probe c0/run-fake-e2e (WS-P0-041; backlog verify_probe e2e/walking-skeleton-fake; KICKOFF
// c0/run-fake-e2e). The whole C0 loop with the fake vendor and a local bare git remote:
//   fw ledger sync -> fw ledger ready -> fw run start -> (Owner merges by hand) -> fw ledger close
// Environment: FW_VENDOR=fake, FW_GIT_HOST=local (the remote is the fixture's bare repo, origin),
// proxies pointed at a dead port (no network), no API keys; a fake credential sits in
// $FW_HOME/creds/crd_fake0001 and in FW_FAKE_API_KEY so leaks can be detected.
// Acceptance (WS-P0-041):
//   - a fake-vendor run of a fixture row ends with a PR, an evidence bundle and a cost record
//   - failure at any stage leaves a typed failed event and no dangling worktree
//   - fw run start is idempotent: re-running a row that already has a PR, or a done row, refuses
// Also proven here because only the pipeline can produce the state (see probes/c0/README.md):
//   - WS-P0-016: every status change emits ledger.row_status_changed; done -> regressed fires on a
//     failing probe re-run (fw ledger probe after the feature is reverted on main)
//   - WS-P0-021 / C0 exit: fw ledger close after the merge makes the row done with a post-merge
//     evidence bundle bound to the merged SHA
//   - WS-P0-029: the credential never appears in any file under FW_HOME (run directory, logs,
//     database) other than its own creds/ file, nor in the git remote
//   - WS-P0-039: the run is succeeded only with a kernel-verified PR artifact whose sha matches the
//     remote branch head
//   - WS-P0-023: fw audit verify is clean at the end
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  count,
  fakeSecret,
  filesContaining,
  fixtureProject,
  freshHome,
  fw,
  fwJson,
  git,
  openDbReadonly,
  pipelineEnv,
  probe,
  readdirSafe,
} from './_lib.mjs';

await probe('c0/run-fake-e2e', async () => {
  const proj = fixtureProject({ extraRows: [{ id: 'FW-C-903', scenario: 'nonzero_exit' }] });
  const home = freshHome('e2e');
  const secret = fakeSecret('anthropic');
  mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'creds', 'crd_fake0001'), `${secret}\n`, { mode: 0o600 });
  const env = pipelineEnv({ FW_FAKE_API_KEY: secret });
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };

  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  check(fw(['ledger', 'ready', 'FW-C-901', '--json'], o).status === 0, 'fw ledger ready FW-C-901 failed');
  check(fw(['ledger', 'ready', 'FW-C-903', '--json'], o).status === 0, 'fw ledger ready FW-C-903 failed');

  // Happy path.
  const run = fwJson(['run', 'start', 'FW-C-901'], o);
  check(run.status === 0, `fw run start FW-C-901 exited ${run.status}: ${run.stderr.trim().split('\n').pop()}`);
  let db = await openDbReadonly(home);
  const r = db.prepare('SELECT * FROM runs ORDER BY queued_at DESC, rowid DESC LIMIT 1').get();
  check(r, 'no runs row after fw run start');
  check(r.status === 'succeeded', `run status is ${r.status}, want succeeded`);
  const pr = db.prepare("SELECT * FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request'").get(r.id);
  check(pr, 'the run has no pull_request artifact');
  check(pr.verified_by_kernel === 1, 'the pull_request artifact is not kernel-verified');
  const branchHead = git(proj.remote, 'rev-parse', 'refs/heads/row/FW-C-901');
  check(pr.sha === branchHead, `PR artifact sha ${pr.sha} is not the remote branch head ${branchHead}`);
  git(proj.remote, 'cat-file', '-e', `${branchHead}:src/feature.txt`);
  const bundles = count(db, 'SELECT count(*) FROM evidence_bundles WHERE subject_sha = ?', branchHead);
  check(bundles >= 1, 'no evidence bundle bound to the PR head sha');
  const spend = count(db, 'SELECT count(*) FROM spend_entries WHERE run_id = ?', r.id);
  check(spend >= 1, 'no cost record (spend_entries) for the run');
  const row = db.prepare("SELECT status FROM ledger_rows WHERE title LIKE '%FW-C-901%'").get();
  check(row?.status === 'verifying', `row status after the run is ${row?.status}, want verifying`);
  const transitions = db
    .prepare("SELECT payload FROM events WHERE type = 'ledger.row_status_changed'")
    .all()
    .map((e) => e.payload);
  for (const to of ['ready', 'claimed', 'running', 'verifying']) {
    check(transitions.some((p) => p.includes(`"${to}"`)), `no ledger.row_status_changed event for the move to ${to}`);
  }
  db.close();
  const show = fwJson(['run', 'show', r.id], o);
  const bundleHash = (await openDbReadonly(home)).prepare('SELECT bundle_hash FROM evidence_bundles ORDER BY created_at DESC LIMIT 1').get().bundle_hash;
  check(JSON.stringify(show.json).includes(bundleHash), 'fw run show does not carry the evidence bundle hash (the PR comment)');
  check(readdirSafe(join(home, 'worktrees')).length === 0, 'a worktree is left behind after a finished run');

  // Idempotent.
  const again = fw(['run', 'start', 'FW-C-901', '--json'], o);
  check(again.status !== 0, 're-running a row that already has a PR was not refused');
  db = await openDbReadonly(home);
  check(count(db, 'SELECT count(*) FROM runs') === 1, 'a refused re-run still created a run');
  db.close();

  // Failure path.
  const bad = fw(['run', 'start', 'FW-C-903', '--json'], o);
  check(bad.status !== 0, 'a failing fake run (nonzero_exit) exited 0');
  db = await openDbReadonly(home);
  const fr = db.prepare('SELECT * FROM runs ORDER BY queued_at DESC, rowid DESC LIMIT 1').get();
  check(fr.status === 'failed' && fr.failure_class, `failed run is ${fr.status}/${fr.failure_class}, want failed with a failure_class`);
  check(count(db, "SELECT count(*) FROM events WHERE type = 'run.failed' AND run_id = ?", fr.id) >= 1, 'no run.failed event');
  db.close();
  check(readdirSafe(join(home, 'worktrees')).length === 0, 'a worktree is left behind after a failed run');

  // The Owner merges by hand; close; then regress.
  git(proj.work, 'fetch', '-q', 'origin');
  git(proj.work, 'merge', '-q', '--no-ff', '-m', 'Merge row/FW-C-901', 'origin/row/FW-C-901');
  git(proj.work, 'push', '-q', 'origin', 'main');
  const merged = git(proj.work, 'rev-parse', 'HEAD');
  const close = fwJson(['ledger', 'close', 'FW-C-901'], o);
  check(close.status === 0, `fw ledger close FW-C-901 after the merge exited ${close.status}: ${close.stderr.trim().split('\n').pop()}`);
  db = await openDbReadonly(home);
  const done = db.prepare("SELECT * FROM ledger_rows WHERE title LIKE '%FW-C-901%'").get();
  check(done.status === 'done', `row status after close is ${done.status}, want done`);
  check(done.merged_sha === merged, 'merged_sha is not the merge commit');
  check(
    count(db, 'SELECT count(*) FROM evidence_bundles WHERE id = ? AND subject_sha = ?', done.evidence_bundle_id, merged) === 1,
    'the closing evidence bundle is not bound to the merged SHA',
  );
  db.close();

  rmSync(join(proj.work, 'src/feature.txt'));
  git(proj.work, 'commit', '-qam', 'revert the feature');
  git(proj.work, 'push', '-q', 'origin', 'main');
  fw(['ledger', 'probe', 'FW-C-901', '--json'], o);
  db = await openDbReadonly(home);
  const reg = db.prepare("SELECT status FROM ledger_rows WHERE title LIKE '%FW-C-901%'").get();
  check(reg.status === 'regressed', `after a failing probe re-run the done row is ${reg.status}, want regressed`);
  check(count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_regressed'") >= 1, 'no ledger.row_regressed event');
  db.close();

  const audit = fw(['audit', 'verify', '--json'], o);
  check(audit.status === 0, `fw audit verify after the loop exited ${audit.status}`);

  const leaks = filesContaining(home, secret).filter((p) => !p.startsWith(join(home, 'creds')));
  check(leaks.length === 0, `the credential leaked into: ${leaks.join(', ')}`);
  check(filesContaining(proj.remote, secret).length === 0, 'the credential leaked into the git remote');
});
