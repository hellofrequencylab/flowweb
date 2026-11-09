import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LocalBareHost } from '../src/edge-git/local-bare-host.ts';
import { checkRunArtifact } from '../src/runtime/artifact-guard.ts';
import { branchChanges } from '../src/runtime/branch-diff.ts';
import { git } from '../src/runtime/exec.ts';
import { quarantineBranch } from '../src/runtime/quarantine.ts';
import { WorktreeManager } from '../src/runtime/worktrees.ts';
import { commitAll, initRepo, tempDir, writeFile } from './git-fixtures.ts';

let tmp: ReturnType<typeof tempDir>;
let repo: string;
let base: string;
let mgr: WorktreeManager;
const allowedFiles = ['packages/daemon/**'];

beforeEach(async () => {
  tmp = tempDir();
  ({ repo, base } = await initRepo(join(tmp.path, 'repo'), {
    CODEOWNERS: '* @owner\n',
    'probes/c0/x.mjs': 'export default 1;\n',
    'packages/daemon/src/a.ts': 'export const a = 1;\n',
    'packages/daemon/src/old.ts': 'export const old = 1;\n',
  }));
  mgr = new WorktreeManager({ fwHome: join(tmp.path, 'fwhome'), repoPath: repo });
});
afterEach(() => tmp.cleanup());

async function runWorktree(runId: string, rowId = 'R-1') {
  const r = await mgr.create({ run_id: runId, row_id: rowId, base_ref: 'main' });
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe('branchChanges', () => {
  test('reports adds, modifies, renames and deletions since the merge base', async () => {
    const wt = await runWorktree('run_a');
    writeFile(wt.path, 'packages/daemon/src/a.ts', 'export const a = 2;\n');
    writeFile(wt.path, 'packages/daemon/src/new.ts', 'export const n = 1;\n');
    await git(wt.path, ['mv', 'packages/daemon/src/old.ts', 'packages/daemon/src/renamed.ts']);
    await git(wt.path, ['rm', '--quiet', 'probes/c0/x.mjs']);
    await commitAll(wt.path, 'work');
    // main moving on does not leak into the branch diff (three-dot form).
    writeFile(repo, 'packages/daemon/src/main-only.ts', 'x\n');
    await commitAll(repo, 'main moves');
    const changes = await branchChanges(repo, 'main', wt.branch);
    expect(changes).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'packages/daemon/src/a.ts' },
        { status: 'A', path: 'packages/daemon/src/new.ts' },
        { status: 'R', old_path: 'packages/daemon/src/old.ts', path: 'packages/daemon/src/renamed.ts' },
        { status: 'D', path: 'probes/c0/x.mjs' },
      ]),
    );
    expect(changes).toHaveLength(4);
  });
});

describe('checkRunArtifact', () => {
  test('a commit inside the allowed files is a verified artifact', async () => {
    const wt = await runWorktree('run_a');
    writeFile(wt.path, 'packages/daemon/src/a.ts', 'export const a = 2;\n');
    const head = await commitAll(wt.path, 'work');
    const r = await checkRunArtifact({ repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles });
    expect(r).toMatchObject({
      ok: true,
      reason: 'verified',
      head_sha: head,
      commits_ahead: 1,
      failure_class: null,
    });
    expect(r.verdict?.allowed).toBe(true);
  });

  test('claimed success with no commit is not an artifact', async () => {
    const wt = await runWorktree('run_a');
    expect(
      await checkRunArtifact({ repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles }),
    ).toMatchObject({
      ok: false,
      reason: 'no_commits',
      failure_class: 'no_artifact',
    });
    await commitAll(wt.path, 'empty commit');
    expect(
      (await checkRunArtifact({ repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles })).reason,
    ).toBe('empty_diff');
    expect(
      (await checkRunArtifact({ repoPath: repo, baseRef: base, branch: 'fw/R-1/run_none', allowedFiles }))
        .reason,
    ).toBe('branch_missing');
  });

  test('a run touching CODEOWNERS or a probe fails policy and its branch is quarantined', async () => {
    for (const [runId, file] of [
      ['run_owners', 'CODEOWNERS'],
      ['run_probe', 'probes/c0/x.mjs'],
    ] as const) {
      const wt = await runWorktree(runId, `R-${runId}`);
      writeFile(wt.path, 'packages/daemon/src/a.ts', 'export const a = 3;\n');
      writeFile(wt.path, file, 'tampered\n');
      const head = await commitAll(wt.path, 'sneaky');
      const r = await checkRunArtifact({ repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles });
      expect(r).toMatchObject({ ok: false, reason: 'policy_violation', head_sha: head });
      expect(r.verdict?.violations).toEqual([{ path: file, rule: 'tier0_path', status: 'M' }]);

      const q = await quarantineBranch({ repoPath: repo, branch: wt.branch, run_id: runId });
      expect(q).toEqual({
        quarantined: true,
        run_id: runId,
        from: wt.branch,
        to: `fw/quarantine/${runId}`,
        sha: head,
      });
      expect(await git(repo, ['branch', '--list', wt.branch])).toBe('');
      expect(await git(repo, ['rev-parse', `fw/quarantine/${runId}`])).toBe(head);
      // The worktree follows the rename, and the run branch can no longer be found.
      expect(await git(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(`fw/quarantine/${runId}`);
      expect(
        (await checkRunArtifact({ repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles })).reason,
      ).toBe('branch_missing');
      expect(await quarantineBranch({ repoPath: repo, branch: wt.branch, run_id: runId })).toMatchObject({
        quarantined: false,
        reason: 'branch_missing',
      });
    }
  });

  test('quarantine refuses to overwrite an existing quarantine branch and rejects bad input', async () => {
    const wt = await runWorktree('run_a');
    await git(repo, ['branch', 'fw/quarantine/run_a', 'main']);
    expect(await quarantineBranch({ repoPath: repo, branch: wt.branch, run_id: 'run_a' })).toMatchObject({
      quarantined: false,
      reason: 'target_exists',
    });
    await expect(quarantineBranch({ repoPath: repo, branch: '-D', run_id: 'run_a' })).rejects.toThrow();
    await expect(quarantineBranch({ repoPath: repo, branch: wt.branch, run_id: '../x' })).rejects.toThrow();
  });

  test('a work order scope violation fails too', async () => {
    const wt = await runWorktree('run_a');
    writeFile(wt.path, 'packages/web/src/x.ts', 'x\n');
    await commitAll(wt.path, 'out of scope');
    const r = await checkRunArtifact({ repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles });
    expect(r.reason).toBe('policy_violation');
    expect(r.verdict?.violations[0]?.rule).toBe('outside_allowed_files');
  });

  test('claimed pointers are re-checked against git and the host; a fabricated PR is caught', async () => {
    const host = await LocalBareHost.init(join(tmp.path, 'remote.git'));
    await host.pushBranch({ cwd: repo, branch: 'main' });
    const wt = await runWorktree('run_a');
    writeFile(wt.path, 'packages/daemon/src/a.ts', 'export const a = 2;\n');
    const head = await commitAll(wt.path, 'work');
    const input = { repoPath: repo, baseRef: base, branch: wt.branch, allowedFiles, host };

    expect(await checkRunArtifact({ ...input, claimed: { head_sha: 'f'.repeat(40) } })).toMatchObject({
      ok: false,
      reason: 'claimed_head_mismatch',
      failure_class: 'claim_mismatch',
    });
    expect((await checkRunArtifact(input)).reason).toBe('not_pushed');

    await host.pushBranch({ cwd: wt.path, branch: wt.branch });
    // The agent says it opened PR #1 at a made-up URL; nothing exists on the host.
    expect(
      await checkRunArtifact({
        ...input,
        claimed: { pr: { number: 1, url: 'https://example.invalid/pull/1' } },
      }),
    ).toMatchObject({ ok: false, reason: 'pr_not_found', failure_class: 'claim_mismatch' });

    const pr = await host.openPullRequest({ title: 't', body: 'b', head: wt.branch, base: 'main' });
    expect(
      (
        await checkRunArtifact({
          ...input,
          claimed: { pr: { number: pr.number, url: 'https://example.invalid/pull/1' } },
        })
      ).reason,
    ).toBe('pr_url_mismatch');
    const ok = await checkRunArtifact({
      ...input,
      claimed: { head_sha: head, pr: { number: pr.number, url: pr.url } },
    });
    expect(ok).toMatchObject({ ok: true, reason: 'verified', head_sha: head });
    expect(ok.pr).toMatchObject({ number: pr.number, head_sha: head, state: 'open' });

    // Local branch moves after the push: the host copy no longer matches.
    writeFile(wt.path, 'packages/daemon/src/b.ts', 'b\n');
    await commitAll(wt.path, 'more');
    expect((await checkRunArtifact(input)).reason).toBe('remote_head_mismatch');

    // A PR for a different branch is not this run's artifact.
    const other = await runWorktree('run_b', 'R-2');
    writeFile(other.path, 'packages/daemon/src/c.ts', 'c\n');
    await commitAll(other.path, 'other');
    await host.pushBranch({ cwd: other.path, branch: other.branch });
    const otherPr = await host.openPullRequest({ title: 'o', body: '', head: other.branch, base: 'main' });
    await host.pushBranch({ cwd: wt.path, branch: wt.branch });
    expect((await checkRunArtifact({ ...input, claimed: { pr: { number: otherPr.number } } })).reason).toBe(
      'pr_branch_mismatch',
    );
  });

  test('missing base ref', async () => {
    expect(
      (await checkRunArtifact({ repoPath: repo, baseRef: 'nothing', branch: 'main', allowedFiles })).reason,
    ).toBe('base_missing');
  });
});

test('the daemon Tier 0 list adds agent instruction files to the policy list', async () => {
  const { CORE_TIER0_PATHS } = await import('@fw/policy');
  const { TIER0_PATHS } = await import('../src/runtime/tier0.ts');
  expect(TIER0_PATHS).toEqual(expect.arrayContaining([...CORE_TIER0_PATHS, 'AGENTS.md', 'CLAUDE.md']));
});
