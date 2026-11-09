import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { git } from '../src/runtime/exec.ts';
import { UnsafePathError } from '../src/runtime/paths.ts';
import { parseRunBranch, runBranchName, WorktreeManager } from '../src/runtime/worktrees.ts';
import { commitAll, initRepo, tempDir, writeFile } from './git-fixtures.ts';

let tmp: ReturnType<typeof tempDir>;
let repo: string;
let base: string;
let mgr: WorktreeManager;

beforeEach(async () => {
  tmp = tempDir();
  ({ repo, base } = await initRepo(join(tmp.path, 'repo')));
  mgr = new WorktreeManager({ fwHome: join(tmp.path, 'fwhome'), repoPath: repo });
});
afterEach(() => tmp.cleanup());

describe('WorktreeManager', () => {
  test('creates a worktree under FW_HOME/worktrees on fw/<row>/<run> from the base ref', async () => {
    const r = await mgr.create({ run_id: 'run_a1', row_id: 'WS-P0-032', base_ref: 'main' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(join(mgr.root, 'run_a1'));
    expect(r.branch).toBe('fw/WS-P0-032/run_a1');
    expect(r.base_sha).toBe(base);
    expect(await git(r.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('fw/WS-P0-032/run_a1');
    const list = await mgr.list();
    expect(list).toEqual([
      {
        run_id: 'run_a1',
        path: r.path,
        branch: 'fw/WS-P0-032/run_a1',
        row_id: 'WS-P0-032',
        head_sha: base,
        locked: true,
        present: true,
      },
    ]);
  });

  test('worktree path is outside the main checkout, and a root inside the checkout is refused', async () => {
    const r = await mgr.create({ run_id: 'run_a1', row_id: 'R-1', base_ref: 'main' });
    expect(r.ok && !r.path.startsWith(repo)).toBe(true);
    const inside = new WorktreeManager({ fwHome: join(repo, '.fw-home'), repoPath: repo });
    const r2 = await inside.create({ run_id: 'run_b1', row_id: 'R-2', base_ref: 'main' });
    expect(r2).toMatchObject({ ok: false, reason: 'inside_checkout' });
  });

  test('a second worktree for the same row or the same run is refused', async () => {
    expect((await mgr.create({ run_id: 'run_a1', row_id: 'R-1', base_ref: 'main' })).ok).toBe(true);
    expect(await mgr.create({ run_id: 'run_a2', row_id: 'R-1', base_ref: 'main' })).toMatchObject({
      ok: false,
      reason: 'row_has_active_worktree',
    });
    expect(await mgr.create({ run_id: 'run_a1', row_id: 'R-9', base_ref: 'main' })).toMatchObject({
      ok: false,
      reason: 'path_exists',
    });
  });

  test('bad base ref is reported, not thrown', async () => {
    expect(await mgr.create({ run_id: 'run_a1', row_id: 'R-1', base_ref: 'nope' })).toMatchObject({
      ok: false,
      reason: 'bad_base_ref',
    });
    expect(await mgr.create({ run_id: 'run_a1', row_id: 'R-1', base_ref: '--output=/tmp/x' })).toMatchObject({
      ok: false,
      reason: 'bad_base_ref',
    });
  });

  test('path traversal: run and row ids that could escape are rejected', async () => {
    for (const bad of ['../evil', 'run_../../x', 'run_a/b', '/etc', 'run_', 'run_a\0b', 'x']) {
      expect(() => mgr.pathFor(bad)).toThrow(UnsafePathError);
      await expect(mgr.create({ run_id: bad, row_id: 'R-1', base_ref: 'main' })).rejects.toThrow(
        UnsafePathError,
      );
    }
    await expect(mgr.create({ run_id: 'run_ok', row_id: '../x', base_ref: 'main' })).rejects.toThrow(
      UnsafePathError,
    );
    expect(existsSync(join(tmp.path, 'evil'))).toBe(false);
    await expect(mgr.remove('../../repo')).rejects.toThrow(UnsafePathError);
  });

  test('remove refuses a dirty worktree unless forced, and leaves no stale git metadata', async () => {
    const r = await mgr.create({ run_id: 'run_a1', row_id: 'R-1', base_ref: 'main' });
    if (!r.ok) throw new Error('create failed');
    writeFile(r.path, 'scratch.txt', 'uncommitted\n');
    const refused = await mgr.remove('run_a1');
    expect(refused).toMatchObject({ removed: false, reason: 'dirty', dirty_paths: ['scratch.txt'] });
    expect(existsSync(r.path)).toBe(true);

    const forced = await mgr.remove('run_a1', { force: true });
    expect(forced).toMatchObject({ removed: true, branch: 'fw/R-1/run_a1', branch_deleted: false });
    expect(existsSync(r.path)).toBe(false);
    expect(await mgr.list()).toEqual([]);
    expect(existsSync(join(repo, '.git', 'worktrees', 'run_a1'))).toBe(false);
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('run_a1');
    // The branch is the artifact and survives removal by default.
    expect(await git(repo, ['branch', '--list', 'fw/R-1/run_a1'])).toContain('fw/R-1/run_a1');
  });

  test('remove of a clean worktree with deleteBranch drops the branch; unknown run is not_found', async () => {
    const r = await mgr.create({ run_id: 'run_a1', row_id: 'R-1', base_ref: 'main' });
    if (!r.ok) throw new Error('create failed');
    writeFile(r.path, 'work.txt', 'done\n');
    await commitAll(r.path, 'work');
    expect(await mgr.remove('run_a1', { deleteBranch: true })).toMatchObject({
      removed: true,
      branch_deleted: true,
    });
    expect(await git(repo, ['branch', '--list', 'fw/R-1/run_a1'])).toBe('');
    expect(await mgr.remove('run_zz')).toMatchObject({ removed: false, reason: 'not_found' });
    // The row is free again.
    expect((await mgr.create({ run_id: 'run_a2', row_id: 'R-1', base_ref: 'main' })).ok).toBe(true);
  });

  test('prune: vanished dirs, inactive runs, dead orphan dirs; dirty and unknown dirs are kept', async () => {
    const a = await mgr.create({ run_id: 'run_gone', row_id: 'R-1', base_ref: 'main' });
    const b = await mgr.create({ run_id: 'run_idle', row_id: 'R-2', base_ref: 'main' });
    const c = await mgr.create({ run_id: 'run_dirty', row_id: 'R-3', base_ref: 'main' });
    const d = await mgr.create({ run_id: 'run_live', row_id: 'R-4', base_ref: 'main' });
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error('create failed');
    rmSync(a.path, { recursive: true, force: true }); // crash left metadata behind
    writeFile(c.path, 'wip.txt', 'x');
    // A dead worktree dir whose gitdir no longer exists, and an unrelated dir.
    mkdirSync(join(mgr.root, 'run_dead'));
    writeFileSync(join(mgr.root, 'run_dead', '.git'), 'gitdir: /nonexistent/.git/worktrees/run_dead\n');
    mkdirSync(join(mgr.root, 'notes'));

    const res = await mgr.prune({ activeRunIds: ['run_live'] });
    expect(res).toEqual({
      metadata_pruned: ['run_gone'],
      removed: ['run_idle'],
      skipped_dirty: ['run_dirty'],
      orphan_dirs_removed: ['run_dead'],
      left_alone: ['notes'],
    });
    expect((await mgr.list()).map((w) => w.run_id).sort()).toEqual(['run_dirty', 'run_live']);
    expect(readdirSync(mgr.root).sort()).toEqual(['notes', 'run_dirty', 'run_live']);
  });
});

test('branch name helpers', () => {
  expect(runBranchName('FW-C-008', 'run_x')).toBe('fw/FW-C-008/run_x');
  expect(parseRunBranch('fw/FW-C-008/run_x')).toEqual({ row_id: 'FW-C-008', run_id: 'run_x' });
  expect(parseRunBranch('fw/quarantine/run_x')).toBeNull();
  expect(parseRunBranch('main')).toBeNull();
  expect(() => runBranchName('a/b', 'run_x')).toThrow();
});
