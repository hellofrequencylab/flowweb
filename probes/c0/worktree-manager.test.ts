// Probe c0/worktree-manager (WS-P0-032; backlog verify_probe runtime/worktree-manager).
// Surface: new WorktreeManager({ fwHome, repoPath }) exported by packages/daemon/src/index.ts:
//   create({ run_id, row_id, base_ref }) -> { ok: true, path, branch, base_sha } | { ok: false, reason }
//   list() -> [{ run_id, path, branch, row_id, locked, present }]   remove(run_id, { force?, deleteBranch? })
// Worktrees are keyed by run, one active worktree per row (decision 13), so "a second worktree for
// the same order" is checked both ways: the same run again (path_exists) and another run of the
// same row (row_has_active_worktree). Run branches are fw/<row>/<run> (decision 8).
// Acceptance:
//   - a second worktree for the same order id is refused
//   - removal leaves no stale git metadata (git worktree list and .git/worktrees no longer show it)
//   - the worktree path is outside the main checkout (under $FW_HOME/worktrees/)
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fixtureProject, freshHome, git, requireExport } from './_lib.mjs';

type Created = { ok: boolean; path?: string; branch?: string; base_sha?: string; reason?: string };
type Mgr = {
  create: (i: { run_id: string; row_id: string; base_ref: string }) => Promise<Created>;
  remove: (runId: string, o?: { force?: boolean; deleteBranch?: boolean }) => Promise<{ removed: boolean; reason?: string }>;
  list: () => Promise<{ run_id: string; path: string; row_id: string | null }[]>;
};

describe('c0/worktree-manager', () => {
  test('one worktree per order, outside the checkout, removed cleanly', async () => {
    const WorktreeManager = (await requireExport('daemon', 'WorktreeManager', 'WS-P0-032')) as new (o: {
      fwHome: string;
      repoPath: string;
    }) => Mgr;
    const proj = fixtureProject();
    const home = realpathSync(freshHome('wt'));
    const base = git(proj.work, 'rev-parse', 'HEAD');
    const m = new WorktreeManager({ fwHome: home, repoPath: proj.work });
    const run = 'run_01PROBEWT000000000000000A';
    const run2 = 'run_01PROBEWT000000000000000B';

    const wt = await m.create({ run_id: run, row_id: 'FW-C-901', base_ref: base });
    expect(wt.ok, `create: ${wt.reason}`).toBe(true);
    expect(existsSync(wt.path!), 'worktree exists').toBe(true);
    expect(relative(proj.work, wt.path!).startsWith('..'), 'worktree is outside the main checkout').toBe(true);
    expect(wt.path!.startsWith(join(home, 'worktrees')), 'worktree lives under $FW_HOME/worktrees').toBe(true);
    expect(wt.branch).toBe(`fw/FW-C-901/${run}`);
    expect(git(wt.path!, 'rev-parse', 'HEAD')).toBe(base);

    const again = await m.create({ run_id: run, row_id: 'FW-C-901', base_ref: base });
    expect(again.ok, 'a second worktree for the same run is refused').toBe(false);
    const sameRow = await m.create({ run_id: run2, row_id: 'FW-C-901', base_ref: base });
    expect(sameRow.ok, 'a second worktree for the same row is refused').toBe(false);
    expect(sameRow.reason).toBe('row_has_active_worktree');
    expect((await m.list()).filter((w) => w.row_id === 'FW-C-901').length, 'still one worktree for the row').toBe(1);

    const removed = await m.remove(run, { deleteBranch: true });
    expect(removed.removed, `remove: ${removed.reason}`).toBe(true);
    expect(existsSync(wt.path!), 'worktree directory removed').toBe(false);
    expect(git(proj.work, 'worktree', 'list', '--porcelain')).not.toContain(wt.path!);
    const meta = join(proj.work, '.git', 'worktrees');
    expect(existsSync(meta) ? readdirSync(meta) : [], 'no stale .git/worktrees entries').toEqual([]);
    expect(git(proj.work, 'worktree', 'prune', '--dry-run', '-v'), 'nothing left to prune').toBe('');
    expect(git(proj.work, 'branch', '--list', `fw/FW-C-901/${run}`), 'the run branch is deleted when asked').toBe('');

    const next = await m.create({ run_id: run2, row_id: 'FW-C-901', base_ref: base });
    expect(next.ok, 'after removal the row can get a worktree again').toBe(true);
    await m.remove(run2, { deleteBranch: true });
  });
});
