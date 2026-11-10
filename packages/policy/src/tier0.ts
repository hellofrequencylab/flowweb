// The Tier 0 path list, read from policy/tier0-paths.json: the one list that scripts/check-tier0.mjs,
// AGENTS.md rule 3, CODEOWNERS and core-policy.yaml also follow (check-bootstrap and test/tier0.test.ts
// fail on drift). It is data, so the vendor-named agent instruction files in it keep this code
// vendor-blind. A missing or malformed file throws at import: nothing runs without the list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TIER0_PATHS_FILE = fileURLToPath(new URL('../../../policy/tier0-paths.json', import.meta.url));

export function loadTier0Paths(path: string = TIER0_PATHS_FILE): readonly string[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { paths?: unknown };
  const paths = doc.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p !== ''))
    throw new Error(`${path}: "paths" must be a non-empty list of strings`);
  return Object.freeze([...(paths as string[])]);
}

/**
 * Tier 0 paths (Owner only). Entry forms: `dir/` matches everything under dir; entries with `*` are
 * globs (`*` within one segment, `**` across segments); anything else is an exact repo path.
 * Matching ignores case.
 */
export const CORE_TIER0_PATHS: readonly string[] = loadTier0Paths();
