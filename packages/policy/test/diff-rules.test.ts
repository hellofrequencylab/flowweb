import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CORE_TIER0_PATHS, evaluateDiffPolicy, globToRegExp, type PathChange } from '../src/diff-policy.ts';
import {
  DIFF_POLICY_RULES_PATH,
  dependencyNames,
  parseDiffPolicyRules,
  parsePatch,
} from '../src/diff-rules.ts';

const glob = (g: string) => globToRegExp(g, { caseInsensitive: true });
const filePatch = (path: string, lines: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', ...lines].join('\n');
const check = (changes: PathChange[], patch: string, extra: Record<string, unknown> = {}) =>
  evaluateDiffPolicy({ changes, patch, tier0Paths: CORE_TIER0_PATHS, allowedFiles: ['**'], ...extra });
const rules = (v: { violations: { rule: string }[] }) => v.violations.map((x) => x.rule);
/** Rules hit by a one-file change whose hunk body is `lines` (with their +/- markers). */
const one = (path: string, lines: string[], status = 'M', extra: Record<string, unknown> = {}) =>
  rules(check([{ status, path }], filePatch(path, lines), extra));

describe('diff policy content rules (policy/rules/diff-policy.json)', () => {
  test('the rules file loads; an invalid one is a deny; without a patch only path rules run', () => {
    const text = readFileSync(DIFF_POLICY_RULES_PATH, 'utf8');
    expect(() => parseDiffPolicyRules(text, glob)).not.toThrow();
    expect(() => parseDiffPolicyRules('{"version":1,"rules":{}}', glob)).toThrow(/missing/);
    expect(one('src/a.ts', ['+x'], 'M', { rules: { forbidden_path: {} } })).toEqual(['policy_error']);
    const noPatch = { changes: [{ status: 'M', path: 'src/a.ts' }], tier0Paths: [], allowedFiles: ['**'] };
    expect(evaluateDiffPolicy(noPatch).allowed).toBe(true);
  });

  test('deleted_test: a deleted test file, a test renamed away, and lost test cases', () => {
    expect(rules(check([{ status: 'D', path: 'src/a.test.ts' }], ''))).toEqual(['deleted_test']);
    expect(rules(check([{ status: 'R', old_path: 'test/a.ts', path: 'src/a.ts' }], ''))).toEqual([
      'deleted_test',
    ]);
    const lost = ["-test('one', () => {});", "-it('two', () => {});", "+it('two', () => {});"];
    expect(one('src/a.test.ts', lost)).toEqual(['deleted_test']);
    expect(one('src/a.test.ts', ["-test('one', () => {});", "+test('one again', () => {});"])).toEqual([]);
    expect(one('tests/test_x.py', ['-def test_one():', '-    assert True'])).toEqual(['deleted_test']);
  });

  test('skipped_test: skip, only, todo, x-prefixed and pytest markers; Markdown is exempt', () => {
    for (const line of [
      "test.skip('a', f)",
      "describe.only('b', f)",
      "xit('c', f)",
      '@pytest.mark.xfail',
      "it.todo('d')",
    ])
      expect(one('src/a.test.ts', [`+${line}`]), line).toEqual(['skipped_test']);
    expect(one('docs/x.md', ['+Never use `test.skip(`.'])).toEqual([]);
  });

  test('config_relaxation: changed values, removed lines, deletion and turning things off', () => {
    expect(one('vitest.config.ts', ['-  testTimeout: 30000,', '+  testTimeout: 600000,'])).toEqual([
      'config_relaxation',
    ]);
    expect(one('packages/x/tsconfig.json', ['+    "strict": false,'])).toEqual(['config_relaxation']);
    expect(one('biome.json', ['+      "noExplicitAny": "off"'])).toEqual(['config_relaxation']);
    expect(one('perf-baseline.json', ['-  "p95_ms": 120'], 'D')).toEqual(['config_relaxation']);
    expect(one('biome.json', ['+      "noExplicitAny": "error"'])).toEqual([]);
    expect(one('src/budget.ts', ['-export const A = 1;', '+export const A = 2;'])).toEqual([]);
  });

  test('size_over_cap: S 150, M 400, L 600 changed lines; unknown size gets S; lockfiles not counted', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i}`);
    const at = (n: number, rowSize?: string) => one('src/big.ts', lines(n), 'A', rowSize ? { rowSize } : {});
    for (const [size, cap] of [
      ['S', 150],
      ['M', 400],
      ['L', 600],
    ] as const) {
      expect(at(cap, size)).toEqual([]);
      expect(at(cap + 1, size)).toEqual(['size_over_cap']);
    }
    expect(at(151)).toEqual(['size_over_cap']);
    expect(at(151, 'XL')).toEqual(['size_over_cap']);
    expect(one('pnpm-lock.yaml', lines(5000))).toEqual([]);
  });

  test('new_dependency: a name added to a manifest, unless the work order allows it', () => {
    const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'x', devDependencies: deps });
    const changes = [{ status: 'M', path: 'packages/x/package.json' }];
    const with_ = (before: string, after: string, extra = {}) =>
      check(changes, '', { manifests: [{ path: 'packages/x/package.json', before, after }], ...extra });
    const v = with_(pkg({ a: '1' }), pkg({ a: '2', b: '1' }));
    expect(v.violations).toMatchObject([{ rule: 'new_dependency', detail: 'new: b' }]);
    expect(with_(pkg({ a: '1' }), pkg({ a: '2', b: '1' }), { allowNewDependencies: true }).allowed).toBe(
      true,
    );
    expect(with_(pkg({ a: '1' }), pkg({ a: '2' })).allowed).toBe(true);
    expect(rules(with_(pkg({}), '{'))).toEqual(['new_dependency']);
    expect(rules(check(changes, ''))).toEqual(['new_dependency']);
    const req = 'Requests>=2\n# c\nflask_cors==1 ; python_version>"3"\n-r more.txt\n';
    expect([...dependencyNames(req, 'requirements_txt')]).toEqual(['requests', 'flask-cors']);
  });

  test('parsePatch reads renames, deletions and binary files, and refuses quoted paths', () => {
    const p = [
      'diff --git a/old.ts b/new.ts',
      'rename from old.ts',
      'rename to new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    expect(parsePatch(p)).toEqual([
      { path: 'new.ts', old_path: 'old.ts', added: ['b'], removed: ['a'], binary: false },
      { path: 'gone.ts', old_path: null, added: [], removed: ['x'], binary: false },
      { path: 'img.png', old_path: null, added: [], removed: [], binary: true },
    ]);
    const quoted = 'diff --git "a/x\\ty" "b/x\\ty"\n--- "a/x\\ty"\n+++ "b/x\\ty"\n';
    expect(rules(check([{ status: 'M', path: 'x' }], quoted))).toContain('policy_error');
  });
});
