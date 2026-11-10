// Probe c0/diff-policy (WS-P0-035; backlog verify_probe policy/diff-policy).
// Surface: evaluateDiffPolicy({ changes, patch, manifests, tier0Paths, allowedFiles }) -> { allowed,
// violations: [{ path, rule }], checked, diff_hash }, parseNameStatus(git diff --name-status output) and
// CORE_TIER0_PATHS, exported by packages/policy/src/index.ts. The content rules read the unified diff
// (patch) and the before/after text of changed dependency manifests (decision 12, Owner 2026-11-10);
// with no row size the engine applies the strictest cap (S, 150 changed lines).
// Acceptance:
//   - fixture diffs for each of 6 violation types fail with the named rule:
//     forbidden_path (named tier0_path in the code), deleted_test, skipped_test, config_relaxation,
//     size_over_cap, new_dependency
//   - a clean fixture passes
//   - rules are data in a Tier 0 file, not code constants: policy/rules/diff-policy.json names the
//     six rules (Owner file; see probes/c0/README.md, "Requires the Owner")
// KICKOFF's run-level line (a run touching CODEOWNERS or a probe file fails and the branch is
// quarantined) is c0/diff-policy-run.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { git, requireExport, root, tmpDir, writeFiles } from './_lib.mjs';

type Change = { status: string; path: string; old_path?: string };
type Verdict = { allowed: boolean; violations: { rule: string; path: string }[]; checked: number; diff_hash: string };
type Manifest = { path: string; before: string | null; after: string | null };
type Evaluate = (o: {
  changes: Change[];
  patch: string;
  manifests: Manifest[];
  tier0Paths: readonly string[];
  allowedFiles: readonly string[];
}) => Verdict;

const BASE = {
  'src/a.ts': 'export const a = 1;\n',
  'src/a.test.ts': "import { test, expect } from 'vitest';\ntest('a', () => expect(1).toBe(1));\n",
  'package.json': `${JSON.stringify({ name: 'fx', dependencies: { zod: '3.0.0' } }, null, 2)}\n`,
  'vitest.config.ts': 'export default { test: { testTimeout: 30000 } };\n',
  CODEOWNERS: '* @fixture-owner\n',
};
const ALLOWED = ['src/**', 'package.json', 'vitest.config.ts'];

/** Name-status changes of one commit on the fixture repository, as the pipeline computes them. */
function changesFor(change: (dir: string) => void) {
  const dir = tmpDir('dp');
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, BASE);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  change(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'change', '--allow-empty');
  return {
    nameStatus: git(dir, 'diff', '--name-status', '-M', 'HEAD~1', 'HEAD'),
    patch: git(dir, '-c', 'core.quotePath=false', 'diff', '-M', '--no-color', 'HEAD~1', 'HEAD'),
    manifests: [{ path: 'package.json', before: git(dir, 'show', 'HEAD~1:package.json'), after: git(dir, 'show', 'HEAD:package.json') }],
  };
}

const CONTENT_FIXTURES: Record<string, (d: string) => void> = {
  deleted_test: (d) => rmSync(join(d, 'src/a.test.ts')),
  skipped_test: (d) =>
    writeFiles(d, { 'src/a.test.ts': "import { test, expect } from 'vitest';\ntest.skip('a', () => expect(1).toBe(1));\n" }),
  config_relaxation: (d) => writeFiles(d, { 'vitest.config.ts': 'export default { test: { testTimeout: 600000 } };\n' }),
  size_over_cap: (d) =>
    writeFiles(d, { 'src/big.ts': Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n') }),
  new_dependency: (d) =>
    writeFiles(d, {
      'package.json': `${JSON.stringify({ name: 'fx', dependencies: { zod: '3.0.0', 'left-pad': '1.3.0' } }, null, 2)}\n`,
    }),
};

async function engine() {
  const evaluate = (await requireExport('policy', 'evaluateDiffPolicy', 'WS-P0-035')) as Evaluate;
  const parse = (await requireExport('policy', 'parseNameStatus', 'WS-P0-035')) as (s: string) => Change[];
  const tier0 = (await requireExport('policy', 'CORE_TIER0_PATHS', 'WS-P0-035')) as string[];
  return (change: (d: string) => void) => {
    const d = changesFor(change);
    return evaluate({ changes: parse(d.nameStatus), patch: d.patch, manifests: d.manifests, tier0Paths: tier0, allowedFiles: ALLOWED });
  };
}

describe('c0/diff-policy', () => {
  test('a clean fixture passes; a forbidden path fails with the named rule', async () => {
    const run = await engine();
    const clean = run((d) => writeFiles(d, { 'src/a.ts': 'export const a = 2;\n' }));
    expect(clean.allowed, 'a clean diff passes').toBe(true);
    expect(clean.violations).toEqual([]);
    expect(clean.diff_hash, 'the verdict carries the diff hash').toMatch(/^[0-9a-f]{64}$/);

    const forbidden = run((d) => writeFiles(d, { CODEOWNERS: '* @someone-else\n', 'probes/x.mjs': 'x\n' }));
    expect(forbidden.allowed).toBe(false);
    const named = forbidden.violations.filter((v) => ['forbidden_path', 'tier0_path'].includes(v.rule)).map((v) => v.path);
    expect(named, 'CODEOWNERS and the probe file are named as forbidden paths').toEqual(
      expect.arrayContaining(['CODEOWNERS', 'probes/x.mjs']),
    );

    const outside = run((d) => writeFiles(d, { 'docs/x.md': 'x\n' }));
    expect(outside.violations.map((v) => v.rule), 'a path outside the allowed files is named').toContain(
      'outside_allowed_files',
    );
  });

  for (const [rule, change] of Object.entries(CONTENT_FIXTURES)) {
    test(`${rule}: the fixture fails with the named rule`, async () => {
      const v = (await engine())(change);
      expect(v.allowed, `${rule} fixture must fail`).toBe(false);
      expect(v.violations.map((x) => x.rule), `${rule} fixture names its rule`).toContain(rule);
    });
  }

  test('rules are data in a Tier 0 file', () => {
    const rulesPath = join(root, 'policy/rules/diff-policy.json');
    expect(existsSync(rulesPath), 'policy/rules/diff-policy.json exists (Tier 0 rules data, Owner file)').toBe(true);
    const text = readFileSync(rulesPath, 'utf8');
    for (const r of ['forbidden_path', ...Object.keys(CONTENT_FIXTURES)]) {
      expect(text, `the rules file names ${r}`).toContain(`"${r}"`);
    }
  });
});
