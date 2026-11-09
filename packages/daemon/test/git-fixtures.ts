// Temp git repositories for daemon tests. Nothing here touches the network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../src/runtime/exec.ts';

export const IDENT = [
  '-c',
  'user.name=fw-test',
  '-c',
  'user.email=fw-test@localhost',
  '-c',
  'commit.gpgsign=false',
];

export function tempDir(prefix = 'fw-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function writeFile(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A']);
  await git(repo, [...IDENT, 'commit', '--quiet', '--allow-empty', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** A repo with one commit on main containing the given files. */
export async function initRepo(
  dir: string,
  files: Record<string, string> = { 'README.md': 'hello\n' },
): Promise<{ repo: string; base: string }> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '--quiet', '-b', 'main']);
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  const base = await commitAll(dir, 'initial');
  return { repo: dir, base };
}
