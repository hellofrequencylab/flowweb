// Self-test for scripts/check-bootstrap.mjs. Run: node --test scripts/test/
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  CORE_POLICY,
  checkBootstrap,
  coveredBy,
  parseCodeowners,
  tier0FromAgents,
  tier0FromCorePolicy,
} from '../check-bootstrap.mjs';
import { TIER0 } from '../check-tier0.mjs';

const repo = resolve(import.meta.dirname, '../..');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fw-boot-'));
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CODEOWNERS', '.github/pull_request_template.md', CORE_POLICY]) {
    cpSync(join(repo, f), join(dir, f), { recursive: true });
  }
  return dir;
}
const edit = (dir, f, fn) => writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), 'utf8')));

test('the repository itself passes', () => {
  assert.deepEqual(checkBootstrap(repo), []);
});

test('rule 3 parsing stops at the end of the list', () => {
  const list = tier0FromAgents(
    '3. **Tier 0 paths are Owner-only.** Do not modify: `a/`, `b.md`. A `pair` row may touch them.',
  );
  assert.deepEqual(list, ['a/', 'b.md']);
});

test('coverage ignores the catch-all and accepts parent directories', () => {
  const rules = parseCodeowners('* @o\n/probes/ @o\n/x.md @o\n');
  assert.ok(coveredBy('probes/c0/', rules));
  assert.ok(coveredBy('x.md', rules));
  assert.equal(coveredBy('y.md', rules), null);
});

test('placeholder owner fails', () => {
  const d = fixture();
  edit(d, 'CODEOWNERS', (s) =>
    s.replace('/probes/                                   @hellofrequencylab', '/probes/ @OWNER'),
  );
  assert.ok(checkBootstrap(d).some((e) => e.includes('@OWNER')));
});

test('a Tier 0 path without its own CODEOWNERS rule fails', () => {
  const d = fixture();
  edit(d, 'CODEOWNERS', (s) => s.replace(/^\/schema\.core\.sql.*$/m, ''));
  assert.ok(checkBootstrap(d).some((e) => e.includes('schema.core.sql')));
});

test('AGENTS.md list drifting from check-tier0 fails', () => {
  const d = fixture();
  edit(d, 'AGENTS.md', (s) => s.replace('`config/`, ', ''));
  assert.ok(
    checkBootstrap(d).some((e) => e.includes('config/ is in check-tier0 TIER0 but not in AGENTS.md')),
  );
});

test('core-policy.yaml tier0.paths drifting from the one list fails, in either direction', () => {
  assert.deepEqual(
    new Set(tier0FromCorePolicy(readFileSync(join(repo, CORE_POLICY), 'utf8'))),
    new Set(TIER0),
  );
  const d = fixture();
  edit(d, CORE_POLICY, (s) =>
    s.replace("'config/**', ", '').replace("'AGENTS.md',", "'AGENTS.md', 'extra/**',"),
  );
  const errors = checkBootstrap(d);
  assert.ok(errors.some((e) => e.includes(`config/ is in TIER0 but not in ${CORE_POLICY}`)));
  assert.ok(errors.some((e) => e.includes(`extra/ is in ${CORE_POLICY} tier0 but not in TIER0`)));
  edit(d, CORE_POLICY, (s) => s.replace('trust_tier_paths:', 'trust_tiers_moved:'));
  assert.ok(checkBootstrap(d).some((e) => e.includes('tier0.paths not found')));
});

test('CLAUDE.md must import AGENTS.md; PR template must carry the three fields', () => {
  const d = fixture();
  edit(d, 'CLAUDE.md', (s) => s.replace('@AGENTS.md', 'see AGENTS.md'));
  edit(d, '.github/pull_request_template.md', (s) => s.replace('## Tier touched', '## Tier'));
  const errs = checkBootstrap(d);
  assert.ok(errs.some((e) => e.includes('CLAUDE.md')));
  assert.ok(errs.some((e) => e.includes('tier-touched')));
});
