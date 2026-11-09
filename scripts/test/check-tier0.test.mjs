// Self-test for scripts/check-tier0.mjs. Run: node --test scripts/test/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { evaluate, isAgent, main, matchTier0, TIER0 } from '../check-tier0.mjs';

const quiet = { log() {}, error() {} };

test('Tier 0 matching: directories, exact files and globs', () => {
  assert.equal(matchTier0('probes/c0/event-chain.mjs'), 'probes/');
  assert.equal(matchTier0('ledger/rows/FW-C-004.json'), 'ledger/rows/');
  assert.equal(matchTier0('ledger/backlog/CORE-BACKLOG.json'), 'ledger/backlog/');
  assert.equal(matchTier0('scripts/check-tier0.mjs'), 'scripts/check-*');
  assert.equal(matchTier0('scripts/probe-branch-protection.sh'), 'scripts/probe-*.sh');
  assert.equal(matchTier0('scripts/seed-rows.mjs'), 'scripts/seed-rows.mjs');
  assert.equal(matchTier0('contracts-core/json-schema/common.json'), 'contracts-core/');
  assert.equal(matchTier0('schema.core.sql'), 'schema.core.sql');
  assert.equal(matchTier0('tests/schema_core_test.py'), 'tests/schema_core_test.py');
  assert.equal(matchTier0('.github/workflows/ci.yml'), '.github/');
  assert.equal(matchTier0('packages/eventlog/src/chain.ts'), 'packages/eventlog/src/chain.ts');
  assert.equal(matchTier0('packages/eventlog/src/store.ts'), null);
  assert.equal(matchTier0('scripts/boundary-lint.mjs'), null);
  assert.equal(matchTier0('scripts/sub/check-x.mjs'), null, '* does not cross a slash');
  assert.equal(matchTier0('xprobes/a'), null, 'directory patterns anchor at the root');
  assert.equal(matchTier0('schema.core.sqlx'), null, 'exact files are exact');
});

test('agent identity: [bot] always, plus FW_AGENT_LOGINS', () => {
  assert.equal(isAgent('fw-worker[bot]', {}), true);
  assert.equal(isAgent('hellofrequencylab', {}), false);
  assert.equal(isAgent('Agent-One', { FW_AGENT_LOGINS: 'agent-one, other' }), true);
  assert.equal(isAgent('someone', { FW_AGENT_LOGINS: 'agent-one' }), false);
});

test('evaluate: agent + Tier 0 fails, human + Tier 0 passes, agent + normal passes', () => {
  const t0 = ['probes/c0/x.mjs', 'packages/ledger/src/sync.ts'];
  assert.equal(evaluate({ author: 'x[bot]', files: t0, env: {} }).ok, false);
  assert.equal(evaluate({ author: 'hellofrequencylab', files: t0, env: {} }).ok, true);
  assert.equal(evaluate({ author: 'x[bot]', files: ['packages/ledger/src/sync.ts'], env: {} }).ok, true);
  const only = evaluate({
    author: 'x[bot]',
    files: ['AGENTS.md'],
    env: {},
    patterns: ['probes/', 'ledger/rows/'],
  });
  assert.equal(only.ok, true, '--only narrows the patterns');
});

test('main fails closed on missing env and on unknown --only patterns', () => {
  assert.equal(main([], {}, quiet), 2);
  assert.equal(main(['--only', 'src/'], { PR_AUTHOR: 'a', BASE_SHA: 'b', HEAD_SHA: 'c' }, quiet), 2);
  assert.equal(main([], { PR_AUTHOR: 'a[bot]', BASE_SHA: 'nope', HEAD_SHA: 'nope2' }, quiet), 2);
});

test('main against a real git history (rename away from probes/ is caught)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fw-tier0-'));
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const put = (p, c) => {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  put('probes/c0/a.mjs', 'probe\n');
  put('src/a.ts', 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'agent');
  put('src/a.ts', 'b\n');
  git('commit', '-qam', 'normal');
  const clean = git('rev-parse', 'HEAD');
  git('mv', 'probes/c0/a.mjs', 'src/moved.mjs');
  git('commit', '-qm', 'move probe away');
  const dirty = git('rev-parse', 'HEAD');
  const env = (head, author = 'w[bot]') => ({ PR_AUTHOR: author, BASE_SHA: base, HEAD_SHA: head });
  assert.equal(main(['--repo', repo], env(clean), quiet), 0);
  assert.equal(main(['--repo', repo], env(dirty), quiet), 1);
  assert.equal(main(['--repo', repo, '--only', 'probes/,ledger/rows/'], env(dirty), quiet), 1);
  assert.equal(main(['--repo', repo], env(dirty, 'hellofrequencylab'), quiet), 0);
});

test('TIER0 has no duplicates', () => {
  assert.equal(new Set(TIER0).size, TIER0.length);
});
