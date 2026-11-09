// Probe c0/diff-policy (WS-P0-035; backlog verify_probe policy/diff-policy).
// Surface: evaluateDiffPolicy({ diff, workOrder, rules }) exported by packages/policy/src/index.ts,
// returning { ok: boolean, violations: [{ rule: string, path?: string, detail?: string }] }.
//   diff: unified diff text (git diff base..head), workOrder: work-order.json, rules: the parsed
//   Tier 0 file policy/rules/diff-policy.json.
// Acceptance:
//   - fixture diffs for each of 6 violation types fail with the named rule:
//     forbidden_path, deleted_test, skipped_test, config_relaxation, size_over_cap, new_dependency
//   - a clean fixture passes
//   - rules are data in a Tier 0 file, not code constants: the file names the six rules, and
//     evaluating with an edited copy of the rules changes the verdict
// KICKOFF's run-level line (a run touching CODEOWNERS or a probe file fails and the branch is
// quarantined) is c0/diff-policy-run, which needs the pipeline (WS-P0-041).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { git, missing, requireExport, root, tmpDir, writeFiles } from './_lib.mjs';

type Verdict = { ok: boolean; violations: { rule: string }[] };
type Evaluate = (o: { diff: string; workOrder: unknown; rules: unknown }) => Verdict | Promise<Verdict>;

const RULES = ['forbidden_path', 'deleted_test', 'skipped_test', 'config_relaxation', 'size_over_cap', 'new_dependency'];

const BASE = {
  'src/a.ts': 'export const a = 1;\n',
  'src/a.test.ts': "import { test, expect } from 'vitest';\ntest('a', () => expect(1).toBe(1));\n",
  'package.json': `${JSON.stringify({ name: 'fx', dependencies: { zod: '3.0.0' } }, null, 2)}\n`,
  'vitest.config.ts': 'export default { test: { testTimeout: 30000 } };\n',
  CODEOWNERS: '* @fixture-owner\n',
};

function diffFor(change: (dir: string) => void) {
  const dir = tmpDir('dp');
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, BASE);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  change(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'change', '--allow-empty');
  return git(dir, 'diff', 'HEAD~1', 'HEAD');
}

const FIXTURES: Record<string, (d: string) => void> = {
  forbidden_path: (d) => writeFiles(d, { CODEOWNERS: '* @someone-else\n' }),
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

function workOrder() {
  const wo = JSON.parse(readFileSync(join(root, 'contracts-core/examples/03-work-order.json'), 'utf8'));
  wo.scope = { touches: ['src/**', 'package.json', 'vitest.config.ts'], forbidden: ['.github/**'] };
  wo.constraints = { ...(wo.constraints ?? {}), no_new_dependencies: true, max_diff_lines: 200, max_files: 6 };
  return wo;
}

describe('c0/diff-policy', () => {
  test('six violation types are named; a clean diff passes; rules are data', async () => {
    const rulesPath = join(root, 'policy/rules/diff-policy.json');
    if (!existsSync(rulesPath)) missing('policy/rules/diff-policy.json does not exist (Tier 0 rules data, WS-P0-035)');
    const evaluate = (await requireExport('policy', 'evaluateDiffPolicy', 'WS-P0-035')) as Evaluate;
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    const text = JSON.stringify(rules);
    for (const r of RULES) expect(text, `the rules file names ${r}`).toContain(`"${r}"`);

    const wo = workOrder();
    const clean = await evaluate({ diff: diffFor((d) => writeFiles(d, { 'src/a.ts': 'export const a = 2;\n' })), workOrder: wo, rules });
    expect(clean, 'a clean diff passes').toMatchObject({ ok: true });
    expect(clean.violations).toEqual([]);

    for (const [rule, change] of Object.entries(FIXTURES)) {
      const v = await evaluate({ diff: diffFor(change), workOrder: wo, rules });
      expect(v.ok, `${rule} fixture must fail`).toBe(false);
      expect(v.violations.map((x) => x.rule), `${rule} fixture names its rule`).toContain(rule);
    }

    // Data, not constants: remove the forbidden_path rule from a copy, and the CODEOWNERS change
    // must no longer be reported under that rule.
    const relaxed = JSON.parse(text.replaceAll('"forbidden_path"', '"forbidden_path_disabled_by_probe"'));
    const v = await evaluate({ diff: diffFor(FIXTURES.forbidden_path!), workOrder: wo, rules: relaxed });
    expect(v.violations.map((x) => x.rule), 'verdict follows the rules data').not.toContain('forbidden_path');
  });
});
