// A GitHost over the `gh` and `git` CLIs. Argv arrays only, never a shell string. The token is read by gh
// from the environment (GH_TOKEN or GITHUB_TOKEN); this class never takes a token as an argument.
import { type ExecOptions, type ExecResult, execArgv, gitEnv } from '../runtime/exec.ts';
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

export type Runner = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

export interface GhHostLogEntry {
  event: 'git_host.retry' | 'git_host.gave_up';
  cmd: string;
  attempt: number;
  delay_ms?: number;
  reason: string;
}

export interface GhHostOptions {
  /** owner/name on the host. */
  repo: string;
  /** Environment for gh and git; defaults to process.env. The token comes from here and nowhere else. */
  env?: NodeJS.ProcessEnv;
  /** Git remote name used by pushBranch. Default origin. */
  remote?: string;
  /** Let git authenticate pushes through `gh auth git-credential` (uses the same env token). Default true. */
  ghCredentialHelper?: boolean;
  /** Retries for rate limits and 5xx. Default 3. */
  retries?: number;
  baseDelayMs?: number;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: GhHostLogEntry) => void;
}

export interface TokenScopeReport {
  ok: boolean;
  reason: string;
  token_kind: 'classic' | 'fine_grained_or_app' | 'none' | 'unknown';
  scopes: string[];
  repo_admin: boolean | null;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRANSIENT_RE =
  /HTTP (?:429|5\d\d)|rate limit|secondary rate|timed? ?out|ECONNRESET|connection reset|unexpected EOF|502 Bad Gateway|503 Service/i;
/** Classic token scopes that mean more power than Core needs. */
const FORBIDDEN_SCOPE_RE = /^(?:admin:|delete_repo$|site_admin$|delete:packages$)/;

export class GhHost implements GitHost {
  readonly repo: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly remote: string;
  private readonly ghCredentialHelper: boolean;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly run: Runner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (entry: GhHostLogEntry) => void;

  constructor(opts: GhHostOptions) {
    if (!REPO_RE.test(opts.repo)) throw new GitHostError(`invalid repo: ${JSON.stringify(opts.repo)}`);
    this.repo = opts.repo;
    this.env = opts.env ?? process.env;
    this.remote = opts.remote ?? 'origin';
    this.ghCredentialHelper = opts.ghCredentialHelper ?? true;
    this.retries = opts.retries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.run = opts.run ?? execArgv;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  async pushBranch(input: { cwd: string; branch: string; force?: boolean }): Promise<PushResult> {
    assertBranchName(input.branch);
    const ref = `refs/heads/${input.branch}`;
    const cfg = this.ghCredentialHelper
      ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
      : [];
    await this.call(
      'git',
      [
        ...cfg,
        'push',
        '--porcelain',
        ...(input.force ? ['--force-with-lease'] : []),
        this.remote,
        `${ref}:${ref}`,
      ],
      { cwd: input.cwd },
    );
    const sha = (
      await this.call('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: input.cwd })
    ).trim();
    return { branch: input.branch, sha };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    assertBranchName(input.head);
    assertBranchName(input.base);
    const out = await this.call(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        this.repo,
        `--title=${input.title}`,
        '--body-file',
        '-',
        `--head=${input.head}`,
        `--base=${input.base}`,
      ],
      { input: input.body },
    );
    const url = out.trim().split('\n').pop() ?? '';
    const m = /\/pull\/(\d+)\s*$/.exec(url);
    if (!m) throw new GitHostError(`gh pr create returned no pull request URL: ${out.trim()}`);
    const status = await this.getPrStatus(Number(m[1]));
    return { number: status.number, url: status.url, head_sha: status.head_sha };
  }

  async commentOnPr(number: number, body: string): Promise<{ url: string | null }> {
    const out = await this.call(
      'gh',
      ['pr', 'comment', prNumber(number), '--repo', this.repo, '--body-file', '-'],
      {
        input: body,
      },
    );
    const url = out.trim().split('\n').pop();
    return { url: url && /^https?:\/\//.test(url) ? url : null };
  }

  async getPrStatus(number: number): Promise<PrStatus> {
    const out = await this.call('gh', [
      'pr',
      'view',
      prNumber(number),
      '--repo',
      this.repo,
      '--json',
      'number,url,state,headRefName,baseRefName,headRefOid,mergeCommit',
    ]);
    const j = JSON.parse(out) as {
      number: number;
      url: string;
      state: string;
      headRefName: string;
      baseRefName: string;
      headRefOid: string;
      mergeCommit: { oid: string } | null;
    };
    const state = j.state.toLowerCase();
    if (state !== 'open' && state !== 'merged' && state !== 'closed') {
      throw new GitHostError(`unexpected PR state ${j.state}`);
    }
    return {
      number: j.number,
      url: j.url,
      state: state as PrState,
      head: j.headRefName,
      base: j.baseRefName,
      head_sha: j.headRefOid,
      merged_sha: state === 'merged' ? (j.mergeCommit?.oid ?? null) : null,
    };
  }

  async getHeadSha(branch: string): Promise<string | null> {
    assertBranchName(branch);
    const args = ['api', `repos/${this.repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'];
    const res = await this.callRaw('gh', args, {});
    if (res.code !== 0) {
      if (/HTTP 404|Not Found/i.test(res.stderr)) return null;
      throw new GitHostError(`gh ${args.join(' ')} failed: ${res.stderr.trim()}`);
    }
    const sha = res.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  /**
   * Refuses a token with more power than Core needs: a classic token with admin or delete scopes, or any
   * token that has admin permission on the repository. Fine-grained tokens report no scope header, so the
   * repository permission check is what decides for them.
   */
  async verifyTokenScope(): Promise<TokenScopeReport> {
    if (!this.env.GH_TOKEN && !this.env.GITHUB_TOKEN) {
      return {
        ok: false,
        reason: 'no GH_TOKEN or GITHUB_TOKEN in the environment',
        token_kind: 'none',
        scopes: [],
        repo_admin: null,
      };
    }
    const head = await this.call('gh', ['api', '--include', '--method', 'GET', 'user']);
    const m = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(head);
    const scopes = m
      ? m[1]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const token_kind = m ? 'classic' : 'fine_grained_or_app';
    const bad = scopes.filter((s) => FORBIDDEN_SCOPE_RE.test(s));
    if (bad.length > 0) {
      return {
        ok: false,
        reason: `token has admin-level scopes: ${bad.join(', ')}`,
        token_kind,
        scopes,
        repo_admin: null,
      };
    }
    const perm = (await this.call('gh', ['api', `repos/${this.repo}`, '--jq', '.permissions.admin'])).trim();
    const repo_admin = perm === 'true';
    if (repo_admin) {
      return {
        ok: false,
        reason: `token has admin permission on ${this.repo}`,
        token_kind,
        scopes,
        repo_admin,
      };
    }
    return { ok: true, reason: 'token scope is narrow enough', token_kind, scopes, repo_admin };
  }

  private async call(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<string> {
    const res = await this.callRaw(cmd, args, opts);
    if (res.code !== 0)
      throw new GitHostError(`${cmd} ${args[0] ?? ''} failed: ${res.stderr.trim() || res.stdout.trim()}`);
    return res.stdout;
  }

  /** Runs with retry and exponential backoff on rate limits and 5xx; each retry is logged. */
  private async callRaw(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
    const env = cmd === 'git' ? gitEnv(this.env) : { ...this.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    for (let attempt = 1; ; attempt++) {
      const res = await this.run(cmd, args, { ...opts, env });
      if (res.code === 0 || !TRANSIENT_RE.test(res.stderr)) return res;
      const reason = res.stderr.trim().split('\n')[0] ?? 'transient error';
      if (attempt > this.retries) {
        this.log({ event: 'git_host.gave_up', cmd: `${cmd} ${args[0] ?? ''}`, attempt, reason });
        return res;
      }
      const delay_ms = this.baseDelayMs * 2 ** (attempt - 1);
      this.log({ event: 'git_host.retry', cmd: `${cmd} ${args[0] ?? ''}`, attempt, delay_ms, reason });
      await this.sleep(delay_ms);
    }
  }
}

function prNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new GitHostError(`invalid PR number: ${n}`);
  return String(n);
}
