// Self-test for scripts/seed-rows.mjs. Run: node --test scripts/test/
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { findCycle, seed, toDefinition } from '../seed-rows.mjs';

const repo = resolve(import.meta.dirname, '../..');
const quiet = () => {};

function fixture(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-seed-'));
  cpSync(join(repo, 'contracts-core/json-schema'), join(dir, 'contracts-core/json-schema'), {
    recursive: true,
  });
  const backlog = JSON.parse(readFileSync(join(repo, 'ledger/backlog/CORE-BACKLOG.json'), 'utf8'));
  mutate?.(backlog);
  mkdirSync(join(dir, 'ledger/backlog'), { recursive: true });
  writeFileSync(join(dir, 'ledger/backlog/CORE-BACKLOG.json'), JSON.stringify(backlog));
  return dir;
}

test('committed ledger/rows/ is in sync with the backlog', () => {
  assert.equal(seed({ root: repo, check: true, log: quiet }).ok, true);
});

test('status and other state fields never reach a row file', () => {
  const def = toDefinition({ id: 'FW-C-001', status: 'done', last_probe: {}, merged_sha: 'x', title: 't' });
  assert.deepEqual(Object.keys(def), ['id', 'title']);
});

test('fresh seed writes 67 files, second run changes nothing', () => {
  const dir = fixture();
  const first = seed({ root: dir, log: quiet });
  assert.equal(first.ok, true);
  assert.equal(first.changed.length, 67);
  assert.ok(existsSync(join(dir, 'ledger/rows/WS-P0-044.json')));
  assert.doesNotMatch(readFileSync(join(dir, 'ledger/rows/FW-C-001.json'), 'utf8'), /"status"/);
  assert.equal(seed({ root: dir, log: quiet }).changed.length, 0);
  assert.equal(seed({ root: dir, check: true, log: quiet }).ok, true);
});

test('a dependency cycle is refused', () => {
  const dir = fixture((b) => {
    b.rows.find((r) => r.id === 'FW-C-001').depends_on = ['WS-P0-044'];
  });
  const res = seed({ root: dir, log: quiet });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.startsWith('dependency cycle')));
  assert.equal(existsSync(join(dir, 'ledger/rows')), false, 'nothing written on error');
});

test('a dangling dependency and a bad priority are refused', () => {
  const dir = fixture((b) => {
    b.rows[1].depends_on = ['FW-C-999'];
    b.rows[2].priority = 'P9';
  });
  const res = seed({ root: dir, log: quiet });
  assert.ok(res.errors.some((e) => e.includes('FW-C-999')));
  assert.ok(res.errors.some((e) => e.includes('priority')));
});

test('check mode flags drift', () => {
  const dir = fixture();
  seed({ root: dir, log: quiet });
  writeFileSync(join(dir, 'ledger/rows/FW-C-001.json'), '{}\n');
  assert.equal(seed({ root: dir, check: true, log: quiet }).ok, false);
});

test('findCycle', () => {
  assert.equal(
    findCycle([
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: [] },
    ]),
    null,
  );
  assert.deepEqual(
    findCycle([
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: ['a'] },
    ]),
    ['a', 'b', 'a'],
  );
});
