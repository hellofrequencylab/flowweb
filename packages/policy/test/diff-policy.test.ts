import { describe, expect, test } from 'vitest';
import {
  CORE_TIER0_PATHS,
  evaluateDiffPolicy,
  globToRegExp,
  type PathChange,
  parseNameStatus,
} from '../src/diff-policy.ts';

const allowed = ['packages/daemon/**', 'docs/notes/*.md'];
const check = (changes: PathChange[], allowedFiles: string[] = allowed) =>
  evaluateDiffPolicy({ changes, tier0Paths: CORE_TIER0_PATHS, allowedFiles });

describe('evaluateDiffPolicy', () => {
  test('a clean diff inside the allowed files passes', () => {
    const v = check([
      { status: 'A', path: 'packages/daemon/src/runtime/x.ts' },
      { status: 'M', path: 'docs/notes/today.md' },
      { status: 'D', path: 'packages/daemon/src/old.ts' },
    ]);
    expect(v).toMatchObject({ allowed: true, violations: [], checked: 3 });
    expect(v.diff_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('every Tier 0 entry is caught, for add, modify and delete', () => {
    const samples = [
      'probes/c0/x.mjs',
      'policy/core.yaml',
      'config/routing.json',
      'ledger/rows/WS-P0-001.json',
      'ledger/backlog/CORE-BACKLOG.json',
      'scripts/check-tier0.mjs',
      'scripts/probe-run.sh',
      'scripts/probe.mjs',
      'scripts/seed-rows.mjs',
      'scripts/test/check-tier0.test.mjs',
      'tooling/requirements-ci.txt',
      '.github/workflows/ci.yml',
      'CODEOWNERS',
      'docs/CODEOWNERS',
      'AGENTS.md',
      'CLAUDE.md',
      '.gitleaks.toml',
      '.husky/pre-commit',
      'packages/policy/src/diff-policy.ts',
      'packages/eventlog/src/envelope.ts',
      'packages/eventlog/src/store.ts',
      'packages/contracts/sql/0001_core.sql',
      'packages/contracts/json-schema/run.json',
      'packages/contracts/SCHEMA-SNAPSHOT.sha256',
      'contracts-core/core-policy.yaml',
      'schema.core.sql',
      'tests/schema_core_test.py',
    ];
    for (const status of ['A', 'M', 'D']) {
      const v = check(
        samples.map((path) => ({ status, path })),
        ['**'],
      );
      expect(v.allowed).toBe(false);
      expect(v.violations.map((x) => x.path)).toEqual(samples);
      expect(new Set(v.violations.map((x) => x.rule))).toEqual(new Set(['tier0_path']));
    }
  });

  test('Tier 0 matching ignores case; near misses are not Tier 0', () => {
    expect(check([{ status: 'M', path: 'Probes/x.ts' }], ['**']).violations[0]?.rule).toBe('tier0_path');
    expect(check([{ status: 'M', path: 'agents.md' }], ['**']).violations[0]?.rule).toBe('tier0_path');
    const near = check(
      [
        { status: 'M', path: 'scripts/probes.mjs' },
        { status: 'M', path: 'packages/eventlog/src/lock.ts' },
        { status: 'M', path: 'probesx/a.ts' },
        { status: 'M', path: 'tests/other_test.py' },
      ],
      ['**'],
    );
    expect(near.allowed).toBe(true);
  });

  test('a rename out of a Tier 0 path is a violation on the old path; a copy only checks the new path', () => {
    const v = check([{ status: 'R', old_path: 'probes/c0/x.mjs', path: 'packages/daemon/x.mjs' }]);
    expect(v.violations).toEqual([{ path: 'probes/c0/x.mjs', rule: 'tier0_path', status: 'R' }]);
    const into = check([{ status: 'R', old_path: 'packages/daemon/a.ts', path: 'policy/a.ts' }]);
    expect(into.violations).toEqual([{ path: 'policy/a.ts', rule: 'tier0_path', status: 'R' }]);
    const copy = check([{ status: 'C', old_path: 'AGENTS.md', path: 'packages/daemon/AGENTS-copy.md' }]);
    expect(copy.allowed).toBe(true);
  });

  test('paths outside the work order allowed files are violations; an empty allow list allows nothing', () => {
    const v = check([
      { status: 'M', path: 'packages/cli/src/index.ts' },
      { status: 'A', path: 'docs/notes/deep/x.md' },
      { status: 'R', old_path: 'packages/web/a.ts', path: 'packages/daemon/a.ts' },
    ]);
    expect(v.violations).toEqual([
      { path: 'packages/cli/src/index.ts', rule: 'outside_allowed_files', status: 'M' },
      { path: 'docs/notes/deep/x.md', rule: 'outside_allowed_files', status: 'A' },
      { path: 'packages/web/a.ts', rule: 'outside_allowed_files', status: 'R' },
    ]);
    expect(check([{ status: 'M', path: 'README.md' }], []).allowed).toBe(false);
  });

  test('Tier 0 wins over a broad allow list', () => {
    expect(check([{ status: 'M', path: 'packages/policy/src/index.ts' }], ['packages/**']).allowed).toBe(
      false,
    );
  });

  test('invalid paths and unknown statuses fail closed', () => {
    const v = check(
      [
        { status: 'M', path: '../outside' },
        { status: 'M', path: '/etc/passwd' },
        { status: 'M', path: 'packages/daemon/../policy/x.ts' },
        { status: 'M', path: '"packages/daemon/\\303\\251.ts"' },
        { status: 'U', path: 'packages/daemon/x.ts' },
        { status: 'X', path: 'packages/daemon/y.ts' },
      ],
      ['**'],
    );
    expect(v.violations.map((x) => x.rule)).toEqual([
      'invalid_path',
      'invalid_path',
      'invalid_path',
      'invalid_path',
      'unknown_status',
      'unknown_status',
    ]);
  });

  test('an internal error is a deny', () => {
    const v = evaluateDiffPolicy({
      changes: [{ status: 'M', path: 'packages/daemon/x.ts' }],
      tier0Paths: CORE_TIER0_PATHS,
      allowedFiles: null as unknown as string[],
    });
    expect(v.allowed).toBe(false);
    expect(v.violations[0]?.rule).toBe('policy_error');
  });

  test('caller-supplied Tier 0 entries are honoured', () => {
    const v = evaluateDiffPolicy({
      changes: [{ status: 'M', path: 'VENDOR-INSTRUCTIONS.md' }],
      tier0Paths: [...CORE_TIER0_PATHS, 'VENDOR-INSTRUCTIONS.md'],
      allowedFiles: ['**'],
    });
    expect(v.violations).toEqual([{ path: 'VENDOR-INSTRUCTIONS.md', rule: 'tier0_path', status: 'M' }]);
  });
});

describe('parseNameStatus', () => {
  test('parses the -z form including renames, copies and deletions', () => {
    const out = 'M\0a.ts\0R100\0old/name.ts\0new/name.ts\0D\0gone.ts\0C075\0src.ts\0dst.ts\0A\0has\ttab.ts\0';
    expect(parseNameStatus(out)).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R', old_path: 'old/name.ts', path: 'new/name.ts' },
      { status: 'D', path: 'gone.ts' },
      { status: 'C', old_path: 'src.ts', path: 'dst.ts' },
      { status: 'A', path: 'has\ttab.ts' },
    ]);
  });

  test('parses the tab separated form', () => {
    expect(parseNameStatus('M\ta.ts\nR087\tx.ts\ty.ts\nD\tz.ts\n')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R', old_path: 'x.ts', path: 'y.ts' },
      { status: 'D', path: 'z.ts' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });
});

test('globToRegExp', () => {
  expect(globToRegExp('packages/**').test('packages/a/b.ts')).toBe(true);
  expect(globToRegExp('**/*.test.ts').test('a.test.ts')).toBe(true);
  expect(globToRegExp('**/*.test.ts').test('x/y/a.test.ts')).toBe(true);
  expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  expect(globToRegExp('src/{a,b}.ts').test('src/b.ts')).toBe(true);
  expect(globToRegExp('a?.md').test('ab.md')).toBe(true);
  expect(globToRegExp('dir/').test('dir/x/y')).toBe(true);
  expect(globToRegExp('dir/').test('dirx/y')).toBe(false);
  expect(globToRegExp('a.b').test('axb')).toBe(false);
});
