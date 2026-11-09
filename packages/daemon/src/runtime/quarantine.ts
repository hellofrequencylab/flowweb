// Quarantine for a run branch that failed the diff policy: rename it to fw/quarantine/<run_id> so it can
// never be pushed or merged under its run name. Returns what it did; the caller records the event.

import { assertBranchName } from '../edge-git/port.ts';
import { ExecError, git } from './exec.ts';
import { assertRunId } from './paths.ts';

export function quarantineBranchName(runId: string): string {
  assertRunId(runId);
  return `fw/quarantine/${runId}`;
}

export type QuarantineResult =
  | { quarantined: true; run_id: string; from: string; to: string; sha: string }
  | {
      quarantined: false;
      run_id: string;
      from: string;
      to: string;
      reason: 'branch_missing' | 'target_exists';
    };

async function refSha(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch (e) {
    if (e instanceof ExecError) return null;
    throw e;
  }
}

/** Renames `branch` to fw/quarantine/<run_id> in repoPath. Works when the branch is checked out in a worktree. */
export async function quarantineBranch(input: {
  repoPath: string;
  branch: string;
  run_id: string;
}): Promise<QuarantineResult> {
  const { repoPath, branch, run_id } = input;
  assertBranchName(branch);
  const to = quarantineBranchName(run_id);
  const sha = await refSha(repoPath, `refs/heads/${branch}`);
  if (!sha) return { quarantined: false, run_id, from: branch, to, reason: 'branch_missing' };
  if (await refSha(repoPath, `refs/heads/${to}`)) {
    return { quarantined: false, run_id, from: branch, to, reason: 'target_exists' };
  }
  await git(repoPath, ['branch', '-m', branch, to]);
  return { quarantined: true, run_id, from: branch, to, sha };
}
