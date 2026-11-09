// WS-P0-039: a run succeeds only when the kernel can see an artifact it verified itself: a commit on the
// run branch beyond base whose diff passed policy. Claimed values (head sha, PR pointer) are re-checked
// against git and, when a host is given, re-fetched from the host. Text from the agent never counts.
import { type DiffVerdict, evaluateDiffPolicy } from '@fw/policy';
import { type GitHost, GitHostError, type PrStatus } from '../edge-git/port.ts';
import { branchChanges } from './branch-diff.ts';
import { ExecError, git } from './exec.ts';
import { TIER0_PATHS } from './tier0.ts';

export type ArtifactReason =
  | 'verified'
  | 'base_missing'
  | 'branch_missing'
  | 'no_commits'
  | 'empty_diff'
  | 'policy_violation'
  | 'claimed_head_mismatch'
  | 'not_pushed'
  | 'remote_head_mismatch'
  | 'pr_not_found'
  | 'pr_branch_mismatch'
  | 'pr_head_mismatch'
  | 'pr_url_mismatch'
  | 'pr_not_open';

export interface ArtifactCheck {
  ok: boolean;
  head_sha: string | null;
  reason: ArtifactReason;
  /** Maps onto runs.failure_class; null when ok. */
  failure_class: 'no_artifact' | 'claim_mismatch' | null;
  commits_ahead: number;
  verdict: DiffVerdict | null;
  pr: PrStatus | null;
  detail?: string;
}

export interface ArtifactGuardInput {
  repoPath: string;
  baseRef: string;
  branch: string;
  allowedFiles: readonly string[];
  /** Defaults to TIER0_PATHS. */
  tier0Paths?: readonly string[];
  /** What the agent or adapter said it produced. Optional; each field given is checked. */
  claimed?: { head_sha?: string; pr?: { number: number; url?: string } };
  /** When given, the branch must be on the host at the same sha and any claimed PR is re-fetched. */
  host?: GitHost;
}

async function sha(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  } catch (e) {
    if (e instanceof ExecError) return null;
    throw e;
  }
}

export async function checkRunArtifact(input: ArtifactGuardInput): Promise<ArtifactCheck> {
  const base: Omit<ArtifactCheck, 'ok' | 'reason' | 'failure_class'> = {
    head_sha: null,
    commits_ahead: 0,
    verdict: null,
    pr: null,
  };
  const fail = (
    reason: ArtifactReason,
    failure_class: 'no_artifact' | 'claim_mismatch' = 'no_artifact',
    detail?: string,
  ): ArtifactCheck => ({ ...base, ok: false, reason, failure_class, ...(detail ? { detail } : {}) });

  const baseSha = await sha(input.repoPath, input.baseRef);
  if (!baseSha) return fail('base_missing', 'no_artifact', input.baseRef);
  const headSha = await sha(input.repoPath, `refs/heads/${input.branch}`);
  if (!headSha) return fail('branch_missing', 'no_artifact', input.branch);
  base.head_sha = headSha;

  base.commits_ahead = Number(await git(input.repoPath, ['rev-list', '--count', `${baseSha}..${headSha}`]));
  if (base.commits_ahead === 0) return fail('no_commits');

  const changes = await branchChanges(input.repoPath, baseSha, headSha);
  if (changes.length === 0) return fail('empty_diff');
  base.verdict = evaluateDiffPolicy({
    changes,
    allowedFiles: input.allowedFiles,
    tier0Paths: input.tier0Paths ?? TIER0_PATHS,
  });
  if (!base.verdict.allowed) return fail('policy_violation');

  if (input.claimed?.head_sha !== undefined && input.claimed.head_sha !== headSha) {
    return fail('claimed_head_mismatch', 'claim_mismatch', `claimed ${input.claimed.head_sha}`);
  }

  if (input.host) {
    const remote = await input.host.getHeadSha(input.branch);
    if (!remote) return fail('not_pushed');
    if (remote !== headSha) return fail('remote_head_mismatch', 'claim_mismatch', `host has ${remote}`);
  }

  const claimedPr = input.claimed?.pr;
  if (claimedPr) {
    if (!input.host) return fail('pr_not_found', 'claim_mismatch', 'a PR was claimed but no host was given');
    let pr: PrStatus;
    try {
      pr = await input.host.getPrStatus(claimedPr.number);
    } catch (e) {
      if (e instanceof GitHostError) return fail('pr_not_found', 'claim_mismatch', e.message);
      throw e;
    }
    base.pr = pr;
    if (claimedPr.url !== undefined && claimedPr.url !== pr.url)
      return fail('pr_url_mismatch', 'claim_mismatch');
    if (pr.head !== input.branch)
      return fail('pr_branch_mismatch', 'claim_mismatch', `PR head is ${pr.head}`);
    if (pr.state === 'closed') return fail('pr_not_open', 'claim_mismatch');
    if (pr.head_sha !== headSha)
      return fail('pr_head_mismatch', 'claim_mismatch', `PR head sha ${pr.head_sha}`);
  }

  return { ...base, ok: true, reason: 'verified', failure_class: null };
}
