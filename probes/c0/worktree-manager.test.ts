// Probe c0/worktree-manager (WS-P0-032; backlog verify_probe runtime/worktree-manager).
// Surface: createWorktreeManager({ repo, home }) exported by packages/daemon/src/index.ts, with
//   open(orderId, { baseCommit }) -> { path, branch }   remove(orderId)   list() -> [{ orderId, path }]
// Acceptance:
//   - a second worktree for the same order id is refused
//   - removal leaves no stale git metadata (git worktree list and .git/worktrees no longer show it)
//   - the worktree path is outside the main checkout (under $FW_HOME/worktrees/)
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fixtureProject, freshHome, git, requireExport } from './_lib.mjs';

type Mgr = {
  open: (id: string, o: { baseCommit: string }) => Promise<{ path: string; branch: string }> | { path: string; branch: string };
  remove: (id: string) => Promise<void> | void;
  list: () => Promise<{ orderId: string; path: string }[]> | { orderId: string; path: string }[];
};

describe('c0/worktree-manager', () => {
  test('one worktree per order, outside the checkout, removed cleanly', async () => {
    const create = (await requireExport('daemon', 'createWorktreeManager', 'WS-P0-032')) as (o: {
      repo: string;
      home: string;
    }) => Mgr;
    const proj = fixtureProject();
    const home = freshHome('wt');
    const base = git(proj.work, 'rev-parse', 'HEAD');
    const m = create({ repo: proj.work, home });

    const wt = await m.open('wo_probe0001', { baseCommit: base });
    expect(existsSync(wt.path), 'worktree exists').toBe(true);
    expect(relative(proj.work, wt.path).startsWith('..'), 'worktree is outside the main checkout').toBe(true);
    expect(wt.path.startsWith(join(home, 'worktrees')), 'worktree lives under $FW_HOME/worktrees').toBe(true);
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(base);

    await expect((async () => m.open('wo_probe0001', { baseCommit: base }))(), 'second worktree for the same order').rejects.toThrow();
    expect((await m.list()).filter((w) => w.orderId === 'wo_probe0001').length).toBe(1);

    await m.remove('wo_probe0001');
    expect(existsSync(wt.path), 'worktree directory removed').toBe(false);
    expect(git(proj.work, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
    const meta = join(proj.work, '.git', 'worktrees');
    expect(existsSync(meta) ? readdirSync(meta) : [], 'no stale .git/worktrees entries').toEqual([]);
    expect(git(proj.work, 'worktree', 'prune', '--dry-run', '-v'), 'nothing left to prune').toBe('');
  });
});
