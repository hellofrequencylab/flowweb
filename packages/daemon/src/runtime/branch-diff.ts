// Reads the changed paths of a run branch from git, for the diff policy. Renames and deletions included.
import { type PathChange, parseNameStatus } from '@fw/policy';
import { git } from './exec.ts';

/** Changes on head since its merge base with base (`git diff --name-status -M base...head`). */
export async function branchChanges(
  repoPath: string,
  baseRef: string,
  headRef: string,
): Promise<PathChange[]> {
  const out = await git(repoPath, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--no-ext-diff',
    '--end-of-options',
    `${baseRef}...${headRef}`,
  ]);
  return parseNameStatus(out);
}
