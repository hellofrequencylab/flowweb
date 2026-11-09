// A GitHost backed by a local bare repository, for tests and the fake end-to-end run.
// Pull requests are JSON files in `<bare>.prs/` beside the bare repo. merge() simulates the Owner merging.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExecError, git } from '../runtime/exec.ts';
import {
  assertBranchName,
  type GitHost,
  GitHostError,
  type OpenPullRequestInput,
  type PrState,
  type PrStatus,
  type PullRequestRef,
  type PushResult,
} from './port.ts';

interface StoredPr {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: PrState;
  head_sha: string;
  merged_sha: string | null;
  comments: { id: number; body: string }[];
  created_at: string;
  updated_at: string;
}

const MERGE_IDENT = {
  GIT_AUTHOR_NAME: 'fw-local-host',
  GIT_AUTHOR_EMAIL: 'fw-local-host@localhost',
  GIT_COMMITTER_NAME: 'fw-local-host',
  GIT_COMMITTER_EMAIL: 'fw-local-host@localhost',
};

export class LocalBareHost implements GitHost {
  readonly barePath: string;
  readonly prDir: string;
  private readonly now: () => Date;

  constructor(barePath: string, opts: { now?: () => Date } = {}) {
    this.barePath = resolve(barePath);
    this.prDir = `${this.barePath}.prs`;
    this.now = opts.now ?? (() => new Date());
  }

  /** Creates an empty bare repository whose default branch is `defaultBranch`. */
  static async init(barePath: string, defaultBranch = 'main'): Promise<LocalBareHost> {
    mkdirSync(barePath, { recursive: true });
    await git(barePath, ['init', '--quiet', '--bare', '-b', defaultBranch]);
    return new LocalBareHost(barePath);
  }

  /** The remote URL a checkout can use for this host. */
  get remoteUrl(): string {
    return this.barePath;
  }

  async pushBranch(input: { cwd: string; branch: string; force?: boolean }): Promise<PushResult> {
    assertBranchName(input.branch);
    const ref = `refs/heads/${input.branch}`;
    await git(input.cwd, [
      'push',
      '--quiet',
      ...(input.force ? ['--force'] : []),
      this.barePath,
      `${ref}:${ref}`,
    ]);
    const sha = await this.getHeadSha(input.branch);
    if (!sha) throw new GitHostError(`push of ${input.branch} did not land`);
    return { branch: input.branch, sha };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    assertBranchName(input.head);
    assertBranchName(input.base);
    const head_sha = await this.getHeadSha(input.head);
    if (!head_sha) throw new GitHostError(`head branch ${input.head} does not exist on the host`);
    if (!(await this.getHeadSha(input.base)))
      throw new GitHostError(`base branch ${input.base} does not exist`);
    if (input.head === input.base) throw new GitHostError('head and base are the same branch');
    const all = this.readAll();
    const dup = all.find((p) => p.state === 'open' && p.head === input.head && p.base === input.base);
    if (dup) throw new GitHostError(`a pull request already exists for ${input.head}: #${dup.number}`);
    const number = all.reduce((m, p) => Math.max(m, p.number), 0) + 1;
    const ts = this.now().toISOString();
    this.write({
      number,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      state: 'open',
      head_sha,
      merged_sha: null,
      comments: [],
      created_at: ts,
      updated_at: ts,
    });
    return { number, url: this.prUrl(number), head_sha };
  }

  async commentOnPr(number: number, body: string): Promise<{ url: string | null }> {
    const pr = this.read(number);
    const id = pr.comments.length + 1;
    pr.comments.push({ id, body });
    pr.updated_at = this.now().toISOString();
    this.write(pr);
    return { url: `${this.prUrl(number)}#comment-${id}` };
  }

  async getPrStatus(number: number): Promise<PrStatus> {
    const pr = this.read(number);
    // An open PR follows its branch, like a real host.
    const head_sha = pr.state === 'open' ? ((await this.getHeadSha(pr.head)) ?? pr.head_sha) : pr.head_sha;
    return {
      number,
      url: this.prUrl(number),
      state: pr.state,
      head: pr.head,
      base: pr.base,
      head_sha,
      merged_sha: pr.merged_sha,
    };
  }

  async getHeadSha(branch: string): Promise<string | null> {
    assertBranchName(branch);
    try {
      return await git(this.barePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    } catch (e) {
      if (e instanceof ExecError) return null;
      throw e;
    }
  }

  /** Comments stored on a PR (test helper). */
  comments(number: number): string[] {
    return this.read(number).comments.map((c) => c.body);
  }

  /**
   * Simulates the Owner merging: fast-forwards base when possible, otherwise writes a merge commit.
   * The base ref update is compare-and-set on the value read at the start. Conflicts throw.
   */
  async merge(number: number): Promise<PrStatus> {
    const pr = this.read(number);
    if (pr.state !== 'open') throw new GitHostError(`pull request #${number} is ${pr.state}`);
    const headSha = await this.getHeadSha(pr.head);
    const baseSha = await this.getHeadSha(pr.base);
    if (!headSha || !baseSha) throw new GitHostError(`pull request #${number} lost its head or base branch`);
    let merged: string;
    if (await this.isAncestor(baseSha, headSha)) {
      merged = headSha;
    } else {
      let tree: string;
      try {
        tree = (await git(this.barePath, ['merge-tree', '--write-tree', baseSha, headSha])).split('\n')[0]!;
      } catch (e) {
        if (e instanceof ExecError) throw new GitHostError(`pull request #${number} has merge conflicts`);
        throw e;
      }
      merged = await git(
        this.barePath,
        [
          'commit-tree',
          tree,
          '-p',
          baseSha,
          '-p',
          headSha,
          '-m',
          `Merge pull request #${number} from ${pr.head}`,
        ],
        { env: { ...process.env, ...MERGE_IDENT } },
      );
    }
    await git(this.barePath, ['update-ref', `refs/heads/${pr.base}`, merged, baseSha]);
    pr.state = 'merged';
    pr.head_sha = headSha;
    pr.merged_sha = merged;
    pr.updated_at = this.now().toISOString();
    this.write(pr);
    return this.getPrStatus(number);
  }

  /** Closes a PR without merging (test helper). */
  async close(number: number): Promise<PrStatus> {
    const pr = this.read(number);
    if (pr.state === 'open') {
      pr.head_sha = (await this.getHeadSha(pr.head)) ?? pr.head_sha;
      pr.state = 'closed';
      pr.updated_at = this.now().toISOString();
      this.write(pr);
    }
    return this.getPrStatus(number);
  }

  private prUrl(number: number): string {
    return `${pathToFileURL(this.barePath).href}/pull/${number}`;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await git(this.barePath, ['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch (e) {
      if (e instanceof ExecError && e.code === 1) return false;
      throw e;
    }
  }

  private file(number: number): string {
    if (!Number.isSafeInteger(number) || number < 1) throw new GitHostError(`invalid PR number: ${number}`);
    return join(this.prDir, `${number}.json`);
  }

  private read(number: number): StoredPr {
    const f = this.file(number);
    if (!existsSync(f)) throw new GitHostError(`pull request #${number} not found`);
    return JSON.parse(readFileSync(f, 'utf8')) as StoredPr;
  }

  private readAll(): StoredPr[] {
    if (!existsSync(this.prDir)) return [];
    return readdirSync(this.prDir)
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(this.prDir, n), 'utf8')) as StoredPr);
  }

  private write(pr: StoredPr): void {
    mkdirSync(this.prDir, { recursive: true });
    const f = this.file(pr.number);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(pr, null, 2)}\n`);
    renameSync(tmp, f);
  }
}
