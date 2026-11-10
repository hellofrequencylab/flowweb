// One Tier 0 list (C0 decision 2): policy/tier0-paths.json. Every other copy must agree with it, and
// this test fails `pnpm test` on drift; CI's scripts/check-bootstrap.mjs checks the same in plain node.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALWAYS_FORBIDDEN } from '@fw/ledger';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { CORE_TIER0_PATHS, loadTier0Paths, TIER0_PATHS_FILE } from '../src/tier0.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const canonical = (
  JSON.parse(readFileSync(join(ROOT, 'policy/tier0-paths.json'), 'utf8')) as { paths: string[] }
).paths;
const asDir = (p: string) => p.replace(/\/\*\*$/, '/');

describe('the one Tier 0 list', () => {
  test('CORE_TIER0_PATHS is policy/tier0-paths.json, entry for entry', () => {
    expect(TIER0_PATHS_FILE).toBe(join(ROOT, 'policy/tier0-paths.json'));
    expect([...CORE_TIER0_PATHS]).toEqual(canonical);
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  test('the work-order compiler forbids the same paths (glob form)', () => {
    expect(ALWAYS_FORBIDDEN.map(asDir)).toEqual(canonical);
  });

  test('core-policy.yaml trust_tier_paths.tier0.paths agrees', () => {
    const doc = parse(readFileSync(join(ROOT, 'contracts-core/core-policy.yaml'), 'utf8')) as {
      trust_tier_paths: { tier0: { paths: string[] } };
    };
    expect(new Set(doc.trust_tier_paths.tier0.paths.map(asDir))).toEqual(new Set(canonical));
  });

  test('the event-log chain entries name files that exist (no stale chain.ts)', () => {
    const files = canonical.filter((p) => p.startsWith('packages/eventlog/'));
    expect(files).toEqual(['packages/eventlog/src/envelope.ts', 'packages/eventlog/src/store.ts']);
    for (const f of files) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  test('AGENTS.md rule 3 and CODEOWNERS agree (scripts/check-bootstrap.mjs)', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-bootstrap.mjs'), ROOT], {
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('a malformed list file throws instead of yielding an empty list', () => {
    expect(() => loadTier0Paths(join(ROOT, 'package.json'))).toThrow(/paths/);
  });
});
