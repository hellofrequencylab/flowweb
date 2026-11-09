// WS-P0-036: the git host port. The pipeline codes against this; GhHost and LocalBareHost implement it.

export type PrState = 'open' | 'merged' | 'closed';

export interface PullRequestRef {
  number: number;
  url: string;
  head_sha: string;
}

export interface PrStatus {
  number: number;
  url: string;
  state: PrState;
  head: string;
  base: string;
  head_sha: string;
  /** The commit on base after the merge; null unless merged. */
  merged_sha: string | null;
}

export interface PushResult {
  branch: string;
  sha: string;
}

export interface OpenPullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface GitHost {
  /** Pushes a local branch from the given checkout (a run worktree) to the host. */
  pushBranch(input: { cwd: string; branch: string; force?: boolean }): Promise<PushResult>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef>;
  commentOnPr(number: number, body: string): Promise<{ url: string | null }>;
  /** Re-fetches the PR from the host; never trusts a cached or claimed value. */
  getPrStatus(number: number): Promise<PrStatus>;
  /** Head commit of a branch on the host, or null when the branch does not exist there. */
  getHeadSha(branch: string): Promise<string | null>;
}

export class GitHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHostError';
  }
}

/** Branch names accepted by the hosts: no leading dash, no `..`, no whitespace or control characters. */
export function assertBranchName(branch: string): void {
  if (
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 200 ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    /[\s~^:?*[\\]/.test(branch) ||
    [...branch].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  ) {
    throw new GitHostError(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}
