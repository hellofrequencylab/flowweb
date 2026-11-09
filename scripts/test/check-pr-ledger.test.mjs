// Self-test for scripts/check-pr-ledger.mjs. Run: node --test scripts/test/
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, main, parseLabels, rowIds } from '../check-pr-ledger.mjs';

const quiet = { log() {}, error() {} };

test('row ids from body and labels, HTML comments ignored, duplicates collapse', () => {
  assert.deepEqual(rowIds('Row FW-C-004', []), ['FW-C-004']);
  assert.deepEqual(rowIds('<!-- WS-P0-002 -->', []), []);
  assert.deepEqual(rowIds('FW-C-004 and again FW-C-004', ['FW-C-004']), ['FW-C-004']);
  assert.deepEqual(rowIds('`WS-Pn-nnn` or `FW-C-nnn`', []), [], 'template placeholders are not ids');
  assert.deepEqual(rowIds('WS-P0-0021', []), [], 'a longer number is not a row id');
  assert.deepEqual(parseLabels(' a, WS-P1-003 ,,'), ['a', 'WS-P1-003']);
});

test('exactly one row', () => {
  assert.equal(check({ body: 'FW-C-004', labels: [] }).ok, true);
  assert.equal(check({ body: '', labels: ['WS-P1-003'] }).ok, true);
  assert.equal(check({ body: 'nothing here', labels: [] }).ok, false);
  assert.equal(check({ body: 'FW-C-004 FW-C-005', labels: [] }).ok, false);
  assert.equal(check({ body: 'FW-C-004', labels: ['WS-P0-002'] }).ok, false);
});

test('bootstrap label exempts; other labels do not', () => {
  assert.equal(check({ body: '', labels: ['bootstrap'] }).ok, true);
  assert.equal(check({ body: '', labels: ['housekeeping'] }).ok, false);
});

test('unknown row id is refused when ledger/rows/ exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'fw-prl-'));
  mkdirSync(join(root, 'ledger/rows'), { recursive: true });
  writeFileSync(join(root, 'ledger/rows/FW-C-004.json'), '{}\n');
  assert.equal(check({ body: 'FW-C-004', labels: [], root }).ok, true);
  assert.equal(check({ body: 'FW-C-999', labels: [], root }).ok, false);
  assert.equal(main({ PR_BODY: 'FW-C-999', PR_LABELS: '', FW_REPO_ROOT: root }, quiet), 1);
  assert.equal(main({ PR_BODY: 'FW-C-004', PR_LABELS: '', FW_REPO_ROOT: root }, quiet), 0);
});
