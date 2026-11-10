// Reads the changed paths of a run branch from git, for the diff policy. Renames and deletions included.
import { type ManifestContent, type PathChange, parseNameStatus } from '@fw/policy';
import { execArgv, git } from './exec.ts';

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

/** The unified diff of the same range, for the diff policy's content rules. Text only, no color. */
export async function branchPatch(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  return git(repoPath, [
    '-c',
    'core.quotePath=false',
    'diff',
    '-M',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--end-of-options',
    `${baseRef}...${headRef}`,
  ]);
}

/**
 * Before (at the merge base) and after (at head) text of every changed dependency manifest the rules file
 * names, so new_dependency can compare dependency sets. A file absent on one side is null.
 */
export async function branchManifests(
  repoPath: string,
  baseRef: string,
  headRef: string,
  changes: readonly PathChange[],
  isManifest: (path: string) => boolean,
): Promise<ManifestContent[]> {
  const mergeBase = await git(repoPath, ['merge-base', '--end-of-options', baseRef, headRef]);
  const show = async (rev: string, path: string) => {
    const r = await execArgv('git', ['show', `${rev}:${path}`], { cwd: repoPath });
    return r.code === 0 ? r.stdout : null;
  };
  const out: ManifestContent[] = [];
  for (const c of changes) {
    if (!isManifest(c.path)) continue;
    out.push({
      path: c.path,
      before: await show(mergeBase, c.old_path ?? c.path),
      after: await show(headRef, c.path),
    });
  }
  return out;
}
