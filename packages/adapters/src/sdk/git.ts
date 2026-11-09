// What actually changed in the worktree, read from git rather than from the vendor's claims.
import { execCapture } from './process.ts';

export interface GitChanges {
  head: string | null;
  files_changed: string[];
  lines_added: number;
  lines_removed: number;
}

export async function collectGitChanges(
  cwd: string,
  baseCommit: string,
  env: Record<string, string>,
): Promise<GitChanges | null> {
  const git = (args: string[]) => execCapture('git', ['-c', 'core.quotepath=off', ...args], { cwd, env });
  const head = await git(['rev-parse', 'HEAD']);
  if (head.code !== 0) return null;
  const headSha = head.stdout.trim();
  // base..working tree covers both commits and uncommitted edits to tracked files.
  const numstat = await git(['diff', '--numstat', '--no-renames', baseCommit]);
  if (numstat.code !== 0) return null;
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of numstat.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    files.add(m[3]!);
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard']);
  if (untracked.code === 0) {
    for (const f of untracked.stdout.split('\n')) if (f) files.add(f);
  }
  return {
    head: /^[0-9a-f]{40}$/.test(headSha) ? headSha : null,
    files_changed: [...files].sort(),
    lines_added: added,
    lines_removed: removed,
  };
}
