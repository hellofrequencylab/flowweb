import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequestOf, keepProposals } from '../server/console.mjs';

const block = (body) => ({
  type: 'tool_use',
  id: 'tu_1',
  name: 'propose_change',
  input: { summary: 'Ask for a weekly CSV.', method: 'POST', path: '/v1/build-requests', body },
});

test('a build request is trimmed and checked', () => {
  assert.deepEqual(buildRequestOf({ title: ' CSV ', what: ' Weekly ', done_when: undefined }), {
    title: 'CSV',
    what: 'Weekly',
    done_when: '',
  });
  assert.equal(buildRequestOf({ title: 'x'.repeat(121), what: 'y' }), null);
  assert.equal(buildRequestOf({ title: 'x', what: '' }), null);
});

test('Kevin proposes a build request to owners and admins only', () => {
  const body = { title: 'CSV', what: 'Weekly CSV of leads' };
  for (const role of ['owner', 'admin']) {
    const [p] = keepProposals([block(body)], { role, flows: null });
    assert.equal(p?.kind, 'build.request');
    assert.equal(p?.path, '/build-requests');
    assert.equal(p?.flow, null);
  }
  for (const role of ['helper', 'viewer']) assert.equal(keepProposals([block(body)], { role, flows: null }).length, 0);
});

test('a key-shaped build request is dropped', () => {
  const body = { title: 'Key', what: `use sk-ant-api03-${'a'.repeat(40)}` };
  assert.equal(keepProposals([block(body)], { role: 'owner', flows: null }).length, 0);
});
