// Probe c0/run-fake-e2e (WS-P0-041; backlog verify_probe e2e/walking-skeleton-fake; KICKOFF
// c0/run-fake-e2e). The whole C0 loop with the fake vendor and a local bare git remote:
//   fw ledger sync -> fw run start (premise re-test, work order, run, PR) -> the Owner merges by
//   hand -> fw ledger close --merged-sha -> fw audit verify
// Environment: FW_VENDOR=fake, FW_GIT_HOST=local (origin is the fixture's bare repo), proxies at a
// dead port, no API keys; a fake credential sits in $FW_HOME/creds/crd_fake0001 (the fake adapter's
// optional handle, item 33) so leaks can be detected.
// Acceptance (WS-P0-041):
//   - a fake-vendor run of a fixture row ends with a PR (evidence comment on it), an evidence bundle
//     and a cost record
//   - failure at any stage leaves a typed failed event and no dangling worktree. Decision 34: a
//     failed run KEEPS its worktree for inspection, so "no dangling" is checked as: the worktree is
//     the run's recorded workspace_path, git still knows it (no stale metadata), the lease is
//     released and the row is back to ready; every directory under $FW_HOME/worktrees belongs to a
//     recorded run. A successful run removes its worktree.
//   - fw run start is idempotent: re-running a row whose PR is open, or a done row, refuses and
//     creates no run
// Also proven here because only the pipeline can produce the state (see probes/c0/README.md):
//   - WS-P0-016: each status change emits ledger.row_status_changed; done -> regressed fires on a
//     failing probe re-run (runRowProbe, the executor every probe run goes through; no CLI command
//     re-runs a done row's probe in C0)
//   - WS-P0-021 / C0 exit: fw ledger close after the merge makes the row done with a post-merge
//     evidence bundle bound to the merged SHA
//   - WS-P0-029: the credential never appears in any file under FW_HOME other than its own creds/
//     file, nor in the git remote or the PR comments
//   - WS-P0-030: the run's session id is stored on the runs row
//   - WS-P0-039: the run succeeds only with a kernel-verified PR artifact whose sha is the remote
//     branch head
//   - WS-P0-023: fw audit verify is clean at the end
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  branches,
  check,
  count,
  dbPath,
  fakeSecret,
  filesContaining,
  fixtureProject,
  fw,
  fwJson,
  git,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  readdirSafe,
  root,
  rowStatusOf,
  sha256,
  TSX,
} from './_lib.mjs';

await probe('c0/run-fake-e2e', async () => {
  const proj = fixtureProject({ extraRows: [{ id: 'FW-C-903', scenario: 'fail' }] });
  const home = pipelineHome('e2e');
  const secret = fakeSecret('anthropic');
  mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'creds', 'crd_fake0001'), `${secret}\n`, { mode: 0o600 });
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };

  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');

  // Happy path.
  const run = fwJson(['run', 'start', 'FW-C-901', '--adapter', 'fake'], o);
  check(run.status === 0, `fw run start FW-C-901 exited ${run.status}: ${run.stdout.slice(0, 300)}`);
  const rep = run.json;
  check(rep.ok === true && rep.status === 'succeeded' && rep.row_status === 'verifying', `run report ${JSON.stringify(rep).slice(0, 300)}`);
  check(rep.branch === `fw/FW-C-901/${rep.run_id}`, `run branch is ${rep.branch}, want fw/FW-C-901/<run> (decision 8)`);
  let db = await openDbReadonly(home);
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(rep.run_id);
  check(r?.status === 'succeeded', `run status is ${r?.status}, want succeeded`);
  check(typeof r.session_id === 'string' && r.session_id.length > 0, 'the run session id is not stored on the runs row');
  const pr = db.prepare("SELECT * FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request'").get(r.id);
  check(pr, 'the run has no pull_request artifact');
  check(pr.verified_by_kernel === 1, 'the pull_request artifact is not kernel-verified');
  const branchHead = git(proj.remote, 'rev-parse', `refs/heads/${rep.branch}`);
  check(pr.sha === branchHead, `PR artifact sha ${pr.sha} is not the remote branch head ${branchHead}`);
  check(rep.pr?.head_sha === branchHead, 'the reported PR head is not the remote branch head');
  git(proj.remote, 'cat-file', '-e', `${branchHead}:fw-fake/${rep.run_id}.md`);
  const bundle = db.prepare('SELECT * FROM evidence_bundles WHERE id = ?').get(rep.evidence_bundle_id);
  check(bundle?.subject_sha === branchHead, 'the evidence bundle is not bound to the PR head sha');
  check(bundle.bundle_hash === rep.bundle_hash, 'the reported bundle hash is not the stored one');
  // WS-P0-038 "the literal diff rendered as text": the bundle points at the rendered diff file and
  // binds its bytes by hash (decision 29: the bundle schema has no inline diff field).
  const intent = JSON.parse(bundle.body).intent_payload ?? {};
  const diffFile = join(home, intent.rendered_ref ?? 'missing');
  check(intent.format === 'diff' && existsSync(diffFile), `the bundle's rendered diff ${intent.rendered_ref} does not exist`);
  const diffText = readFileSync(diffFile, 'utf8');
  check(diffText.includes(`+++ b/fw-fake/${rep.run_id}.md`), 'the rendered diff is not the literal diff of the run');
  check(sha256(readFileSync(diffFile)) === intent.payload_hash, 'the bundle does not bind the rendered diff bytes by hash');
  check(count(db, 'SELECT count(*) FROM spend_entries WHERE run_id = ?', r.id) >= 1, 'no cost record (spend_entries) for the run');
  check(rowStatusOf(db, 'FW-C-901') === 'verifying', `row status after the run is ${rowStatusOf(db, 'FW-C-901')}, want verifying`);
  const moves = db
    .prepare("SELECT payload FROM events WHERE type = 'ledger.row_status_changed'")
    .all()
    .map((e) => JSON.parse(e.payload))
    .filter((p) => JSON.stringify(p).includes('lr_FWC901'));
  for (const to of ['ready', 'claimed', 'running', 'verifying']) {
    check(moves.some((p) => Object.values(p).includes(to)), `no ledger.row_status_changed event for the move to ${to}`);
  }
  db.close();
  const prDir = `${proj.remote}.prs`;
  check(filesContaining(prDir, rep.bundle_hash).length >= 1, 'the PR on the host carries no comment with the bundle hash');
  const show = fw(['run', 'show', rep.run_id], o);
  check(show.stdout.includes(rep.bundle_hash), 'fw run show does not carry the evidence bundle hash');
  check(!existsSync(rep.worktree), 'the worktree of a succeeded run was not removed');

  // Idempotent while the PR is open.
  const again = fw(['run', 'start', 'FW-C-901', '--json'], o);
  check(again.status !== 0, 're-running a row that already has an open PR was not refused');
  db = await openDbReadonly(home);
  const runsAfterRefusal = count(db, 'SELECT count(*) FROM runs');
  check(runsAfterRefusal === 1, 'a refused re-run still created a run');
  db.close();

  // Failure path.
  const bad = fwJson(['run', 'start', 'FW-C-903', '--adapter', 'fake', '--scenario', 'fail'], o);
  check(bad.status !== 0, 'a failing fake run exited 0');
  db = await openDbReadonly(home);
  const fr = db.prepare('SELECT * FROM runs WHERE id = ?').get(bad.json.run_id);
  check(fr?.status === 'failed' && fr.failure_class, `failed run is ${fr?.status}/${fr?.failure_class}, want failed with a failure_class`);
  const failedEv = db.prepare("SELECT payload FROM events WHERE type = 'run.failed' AND run_id = ?").all(fr.id);
  check(failedEv.length === 1, `${failedEv.length} run.failed events for the failed run, want 1`);
  check(JSON.parse(failedEv[0].payload).failure_class === fr.failure_class, 'run.failed does not carry the failure_class');
  const leases = db.prepare('SELECT status FROM leases WHERE run_id = ?').all(fr.id).map((l) => l.status);
  check(leases.length === 1 && leases[0] === 'released', `the failed run's lease is ${leases.join(',')}, want released`);
  check(rowStatusOf(db, 'FW-C-903') === 'ready', `the row of the failed run is ${rowStatusOf(db, 'FW-C-903')}, want ready`);
  const recorded = new Set(db.prepare('SELECT workspace_path FROM runs').all().map((x) => resolve(x.workspace_path)));
  db.close();
  check(fr.workspace_path === bad.json.worktree, 'the failed run worktree is not its recorded workspace_path');
  check(existsSync(bad.json.worktree), 'the failed run worktree was not kept for inspection (decision 34)');
  const known = git(proj.work, 'worktree', 'list', '--porcelain');
  for (const d of readdirSafe(join(home, 'worktrees'))) {
    const p = resolve(home, 'worktrees', d);
    check(recorded.has(p), `${p} is a worktree directory no run owns (dangling)`);
    check(known.includes(p), `${p} is not registered with git (stale)`);
  }
  check(git(proj.work, 'worktree', 'prune', '--dry-run', '-v') === '', 'git has stale worktree metadata');

  // The Owner merges by hand, then closes.
  git(proj.work, 'fetch', '-q', 'origin', `${rep.branch}:refs/remotes/origin/pr`);
  git(proj.work, 'merge', '-q', '--no-ff', '-m', `Merge ${rep.branch}`, 'refs/remotes/origin/pr');
  git(proj.work, 'push', '-q', 'origin', 'main');
  const merged = git(proj.work, 'rev-parse', 'HEAD');
  const close = fwJson(['ledger', 'close', 'FW-C-901', '--merged-sha', merged], o);
  check(close.status === 0, `fw ledger close FW-C-901 after the merge exited ${close.status}: ${close.stdout.slice(0, 300)}`);
  check(close.json.status === 'done', `fw ledger close reported ${close.json.status}`);
  db = await openDbReadonly(home);
  const done = db.prepare("SELECT * FROM ledger_rows WHERE id = 'lr_FWC901'").get();
  check(done.status === 'done', `row status after close is ${done.status}, want done`);
  check(done.merged_sha === merged, 'merged_sha is not the merge commit');
  check(
    count(db, 'SELECT count(*) FROM evidence_bundles WHERE id = ? AND subject_sha = ?', done.evidence_bundle_id, merged) === 1,
    'the closing evidence bundle is not bound to the merged SHA',
  );
  db.close();

  // A done row refuses to run again.
  const doneAgain = fw(['run', 'start', 'FW-C-901', '--adapter', 'fake', '--json'], o);
  check(doneAgain.status !== 0, 're-running a done row was not refused');
  db = await openDbReadonly(home);
  check(count(db, 'SELECT count(*) FROM runs') === runsAfterRefusal + 1, 're-running a done row created a run');
  db.close();

  // The feature is reverted on main; the next probe run regresses the done row.
  git(proj.work, 'rm', '-rq', 'fw-fake');
  git(proj.work, 'commit', '-qm', 'revert the feature');
  git(proj.work, 'push', '-q', 'origin', 'main');
  const script = join(home, 'rerun.mts');
  writeFileSync(
    script,
    `import { join } from 'node:path';
import { openStore } from ${JSON.stringify(join(root, 'packages/eventlog/src/index.ts'))};
import { runRowProbe } from ${JSON.stringify(join(root, 'packages/ledger/src/index.ts'))};
const s = openStore({ path: ${JSON.stringify(dbPath(home))}, lockPath: join(${JSON.stringify(home)}, 'fwd.lock') });
const r = await runRowProbe(s.writer!, 'FW-C-901', { repoDir: ${JSON.stringify(proj.work)}, target: 'merged' });
s.close();
console.log(JSON.stringify(r));
`,
  );
  const rerun = spawnSync(TSX, [script], { encoding: 'utf8', timeout: 60000 });
  check(rerun.status === 0, `re-running the done row's probe failed: ${(rerun.stderr || rerun.stdout).split('\n')[0]}`);
  db = await openDbReadonly(home);
  check(rowStatusOf(db, 'FW-C-901') === 'regressed', `after a failing probe re-run the done row is ${rowStatusOf(db, 'FW-C-901')}, want regressed`);
  check(count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_regressed'") === 1, 'no ledger.row_regressed event');
  check(
    db
      .prepare("SELECT payload FROM events WHERE type = 'ledger.row_status_changed'")
      .all()
      .some((e) => e.payload.includes('lr_FWC901') && e.payload.includes('"regressed"')),
    'the move to regressed emitted no ledger.row_status_changed',
  );
  db.close();

  const audit = fwJson(['audit', 'verify'], o);
  check(audit.status === 0 && audit.json.ok === true, `fw audit verify after the loop exited ${audit.status}`);

  const leaks = filesContaining(home, secret).filter((p) => !p.startsWith(join(home, 'creds')));
  check(leaks.length === 0, `the credential leaked into: ${leaks.join(', ')}`);
  check(filesContaining(proj.remote, secret).length === 0, 'the credential leaked into the git remote');
  check(filesContaining(prDir, secret).length === 0, 'the credential leaked into a PR or its comments');
  check(branches(proj.remote, 'row/').length === 0, 'a row/ branch exists on the remote (run branches are fw/<row>/<run>)');
  check(readdirSync(join(home, 'creds')).length === 1, 'unexpected files under $FW_HOME/creds');
});
