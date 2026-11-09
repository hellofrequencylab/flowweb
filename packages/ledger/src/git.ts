// The few read-only git facts the ledger needs. Shells out to git; no git library.
import { spawnSync } from 'node:child_process';

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** The full HEAD sha of the checkout at dir, or undefined when dir is not a git work tree. */
export function gitHead(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '--verify', 'HEAD']);
  return r.ok && /^[0-9a-f]{40}$/.test(r.out) ? r.out : undefined;
}

/** True when no tracked file differs from HEAD (untracked files are ignored). */
export function gitTrackedClean(dir: string): boolean {
  const r = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  return r.ok && r.out === '';
}
