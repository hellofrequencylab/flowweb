// WS-P0-032: one git worktree per run under $FW_HOME/worktrees/<run_id>, on branch fw/<row-id>/<run_id>.
// Pure git plumbing with no database access; callers turn the returned objects into events.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ExecError, git } from './exec.ts';
import { assertRowId, assertRunId, isInside, RUN_ID_RE, runScopedPath } from './paths.ts';

export const RUN_BRANCH_PREFIX = 'fw/';

export function runBranchName(rowId: string, runId: string): string {
  assertRowId(rowId);
  assertRunId(runId);
  return `${RUN_BRANCH_PREFIX}${rowId}/${runId}`;
}

/** Parses fw/<row>/<run> into its parts; null for any other branch (including fw/quarantine/...). */
export function parseRunBranch(branch: string): { row_id: string; run_id: string } | null {
  const m = /^fw\/([^/]+)\/([^/]+)$/.exec(branch);
  if (!m || m[1] === 'quarantine' || !RUN_ID_RE.test(m[2]!)) return null;
  return { row_id: m[1]!, run_id: m[2]! };
}

export interface WorktreeInfo {
  run_id: string;
  path: string;
  branch: string | null;
  row_id: string | null;
  head_sha: string | null;
  locked: boolean;
  /** False when git still has metadata but the directory is gone. */
  present: boolean;
}

export type CreateWorktreeResult =
  | { ok: true; run_id: string; row_id: string; path: string; branch: string; base_sha: string }
  | {
      ok: false;
      run_id: string;
      reason:
        | 'path_exists'
        | 'row_has_active_worktree'
        | 'branch_exists'
        | 'bad_base_ref'
        | 'inside_checkout';
      detail: string;
    };

export type RemoveWorktreeResult =
  | { removed: true; run_id: string; path: string; branch: string | null; branch_deleted: boolean }
  | { removed: false; run_id: string; path: string; reason: 'dirty' | 'not_found'; dirty_paths?: string[] };

export interface PruneResult {
  /** Run ids whose git metadata was pruned because the directory had disappeared. */
  metadata_pruned: string[];
  /** Run ids whose worktree was removed because the run is no longer active. */
  removed: string[];
  /** Run ids kept because the worktree had uncommitted changes and force was not set. */
  skipped_dirty: string[];
  /** Directories under the worktrees root that were dead worktrees (gitdir gone) and were deleted. */
  orphan_dirs_removed: string[];
  /** Directories left alone: they belong to another repository or are not worktrees at all. */
  left_alone: string[];
}

export interface WorktreeManagerOptions {
  fwHome: string;
  /** Any path inside the main checkout of the project repository. */
  repoPath: string;
}

export class WorktreeManager {
  readonly fwHome: string;
  readonly root: string;
  readonly repoPath: string;

  constructor(opts: WorktreeManagerOptions) {
    mkdirSync(join(opts.fwHome, 'worktrees'), { recursive: true });
    this.fwHome = realpathSync(resolve(opts.fwHome));
    this.root = join(this.fwHome, 'worktrees');
    this.repoPath = resolve(opts.repoPath);
  }

  /** The only way a run gets a worktree path. Throws UnsafePathError for anything outside the root. */
  pathFor(runId: string): string {
    return runScopedPath(this.fwHome, 'worktrees', runId);
  }

  async create(input: { run_id: string; row_id: string; base_ref: string }): Promise<CreateWorktreeResult> {
    const { run_id, row_id, base_ref } = input;
    const path = this.pathFor(run_id);
    const branch = runBranchName(row_id, run_id);
    const fail = (reason: Extract<CreateWorktreeResult, { ok: false }>['reason'], detail: string) =>
      ({ ok: false, run_id, reason, detail }) as const;

    const top = realpathSync(await git(this.repoPath, ['rev-parse', '--show-toplevel']));
    if (isInside(top, this.root)) {
      return fail('inside_checkout', `worktrees root ${this.root} is inside the checkout ${top}`);
    }
    if (existsSync(path)) return fail('path_exists', path);
    const active = (await this.list()).find((w) => w.row_id === row_id);
    if (active) return fail('row_has_active_worktree', `${active.run_id} at ${active.path}`);
    if (await this.refExists(`refs/heads/${branch}`)) return fail('branch_exists', branch);

    let base_sha: string;
    try {
      base_sha = await git(this.repoPath, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${base_ref}^{commit}`,
      ]);
    } catch (e) {
      if (e instanceof ExecError) return fail('bad_base_ref', base_ref);
      throw e;
    }
    await git(this.repoPath, ['worktree', 'add', '--quiet', '-b', branch, path, base_sha]);
    await git(this.repoPath, ['worktree', 'lock', '--reason', `fw run ${run_id}`, path]);
    return { ok: true, run_id, row_id, path, branch, base_sha };
  }

  /** Worktrees of this repository that live under $FW_HOME/worktrees. */
  async list(): Promise<WorktreeInfo[]> {
    const out = await git(this.repoPath, ['worktree', 'list', '--porcelain']);
    const result: WorktreeInfo[] = [];
    for (const block of out.split(/\n\n+/)) {
      const fields = new Map<string, string>();
      for (const line of block.split('\n')) {
        if (!line) continue;
        const i = line.indexOf(' ');
        fields.set(i < 0 ? line : line.slice(0, i), i < 0 ? '' : line.slice(i + 1));
      }
      const wt = fields.get('worktree');
      if (!wt || !isAbsolute(wt)) continue;
      const parent = resolve(wt, '..');
      const name = basename(wt);
      if (parent !== this.root || !RUN_ID_RE.test(name)) continue;
      const ref = fields.get('branch');
      const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
      result.push({
        run_id: name,
        path: wt,
        branch,
        row_id: branch ? (parseRunBranch(branch)?.row_id ?? null) : null,
        head_sha: fields.get('HEAD') ?? null,
        locked: fields.has('locked'),
        present: existsSync(wt),
      });
    }
    return result;
  }

  /** Paths with uncommitted changes (tracked or untracked) in a run's worktree. */
  async dirtyPaths(runId: string): Promise<string[]> {
    const out = await git(this.pathFor(runId), ['status', '--porcelain', '--untracked-files=all']);
    return out
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3));
  }

  /** Removes a run's worktree. Refuses a dirty worktree unless force. Keeps the branch unless deleteBranch. */
  async remove(
    runId: string,
    opts: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<RemoveWorktreeResult> {
    const path = this.pathFor(runId);
    const entry = (await this.list()).find((w) => w.run_id === runId);
    if (!entry) return { removed: false, run_id: runId, path, reason: 'not_found' };
    if (entry.present && !opts.force) {
      const dirty = await this.dirtyPaths(runId);
      if (dirty.length > 0) {
        return { removed: false, run_id: runId, path, reason: 'dirty', dirty_paths: dirty };
      }
    }
    if (entry.locked) await git(this.repoPath, ['worktree', 'unlock', path]);
    if (entry.present) {
      await git(this.repoPath, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), path]);
    }
    await git(this.repoPath, ['worktree', 'prune']);
    let branch_deleted = false;
    if (opts.deleteBranch && entry.branch) {
      await git(this.repoPath, ['branch', '-D', '--', entry.branch]);
      branch_deleted = true;
    }
    return { removed: true, run_id: runId, path, branch: entry.branch, branch_deleted };
  }

  /**
   * Cleans up after crashes. Prunes git metadata for worktrees whose directory vanished, removes worktrees
   * of runs not in activeRunIds (when given; dirty ones are kept unless force), and deletes dead worktree
   * directories under the root whose gitdir no longer exists. Unknown directories are never deleted.
   */
  async prune(opts: { activeRunIds?: Iterable<string>; force?: boolean } = {}): Promise<PruneResult> {
    const res: PruneResult = {
      metadata_pruned: [],
      removed: [],
      skipped_dirty: [],
      orphan_dirs_removed: [],
      left_alone: [],
    };
    let entries = await this.list();
    for (const e of entries.filter((w) => !w.present)) {
      if (e.locked) await git(this.repoPath, ['worktree', 'unlock', e.path]);
      res.metadata_pruned.push(e.run_id);
    }
    await git(this.repoPath, ['worktree', 'prune']);

    if (opts.activeRunIds) {
      const active = new Set(opts.activeRunIds);
      entries = await this.list();
      for (const e of entries) {
        if (active.has(e.run_id)) continue;
        const r = await this.remove(e.run_id, opts.force !== undefined ? { force: opts.force } : {});
        if (r.removed) res.removed.push(e.run_id);
        else if (r.reason === 'dirty') res.skipped_dirty.push(e.run_id);
      }
    }

    const registered = new Set((await this.list()).map((w) => w.run_id));
    for (const name of readdirSync(this.root)) {
      if (registered.has(name)) continue;
      const dir = join(this.root, name);
      if (!RUN_ID_RE.test(name) || !statSync(dir).isDirectory()) {
        res.left_alone.push(name);
        continue;
      }
      const gitFile = join(dir, '.git');
      let gitdir: string | null = null;
      try {
        const m = /^gitdir: (.+)$/m.exec(readFileSync(gitFile, 'utf8'));
        gitdir = m ? resolve(dir, m[1]!.trim()) : null;
      } catch {
        gitdir = null;
      }
      const empty = readdirSync(dir).length === 0;
      if (empty || (gitdir !== null && !existsSync(gitdir))) {
        rmSync(dir, { recursive: true, force: true });
        res.orphan_dirs_removed.push(name);
      } else {
        res.left_alone.push(name);
      }
    }
    return res;
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await git(this.repoPath, ['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch (e) {
      if (e instanceof ExecError) return false;
      throw e;
    }
  }
}
