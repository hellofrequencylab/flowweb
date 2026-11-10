import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftRequestOf, fwdCallFor } from '../server/requests.mjs';

const P = '/supervisor/flows/neighborhood-activation/drafts/hnt_1-a';

test('only draft edit, reject and rewrite become requests', () => {
  assert.equal(draftRequestOf('POST', `${P}/approve`, {}), null);
  assert.equal(draftRequestOf('POST', '/supervisor/flows/neighborhood-activation/enable', {}), null);
  assert.equal(draftRequestOf('GET', `${P}/edit`, {}), null);
  assert.deepEqual(draftRequestOf('POST', `${P}/reject`, { anything: 1 }), {
    kind: 'draft.reject',
    flow: 'neighborhood-activation',
    draft_id: 'hnt_1-a',
    payload: {},
  });
});

test('an edit keeps only subject and body, and bad input is refused', () => {
  assert.deepEqual(draftRequestOf('POST', `${P}/edit`, { subject: 'S', body: 'B', status: 'handed_off' }).payload, {
    subject: 'S',
    body: 'B',
  });
  assert.ok(draftRequestOf('POST', `${P}/edit`, {}).error);
  assert.ok(draftRequestOf('POST', `${P}/edit`, { body: '  ' }).error);
  assert.ok(draftRequestOf('POST', `${P}/edit`, { subject: 3 }).error);
  assert.ok(draftRequestOf('POST', `${P}/edit`, { body: 'x'.repeat(20_001) }).error);
  assert.ok(draftRequestOf('POST', '/supervisor/flows/../drafts/x/edit', { body: 'b' }).error);
});

test('a rewrite needs an instruction', () => {
  assert.ok(draftRequestOf('POST', `${P}/rewrite`, {}).error);
  assert.equal(draftRequestOf('POST', `${P}/rewrite`, { instruction: ' warmer ' }).payload.instruction, 'warmer');
  assert.deepEqual(draftRequestOf('POST', `${P}/rewrite`, { instruction: 'x', body: 'B', status: 1 }).payload, {
    instruction: 'x',
    body: 'B',
  });
  assert.deepEqual(
    fwdCallFor({ kind: 'draft.rewrite', flow: 'f', draft_id: 'd', payload: { instruction: 'x', body: 'B' } }).body,
    { instruction: 'x', body: 'B' },
  );
});

test('the relay calls only the matching fwd draft route', () => {
  const r = { kind: 'draft.edit', flow: 'neighborhood-activation', draft_id: 'hnt_1-a', payload: { body: 'B', x: 1 } };
  assert.deepEqual(fwdCallFor(r), { path: `${P}/edit`, body: { body: 'B' } });
  assert.equal(fwdCallFor({ ...r, kind: 'draft.approve' }), null);
  assert.equal(fwdCallFor({ ...r, flow: '../x' }), null);
  assert.deepEqual(fwdCallFor({ ...r, kind: 'draft.reject' }), { path: `${P}/reject`, body: {} });
});

test('a mark carries only a known outcome, and the relay maps it to the mark route', () => {
  assert.deepEqual(draftRequestOf('POST', `${P}/mark`, { outcome: 'replied', status: 'handed_off' }).payload, {
    outcome: 'replied',
  });
  assert.ok(draftRequestOf('POST', `${P}/mark`, {}).error);
  assert.ok(draftRequestOf('POST', `${P}/mark`, { outcome: 'approved' }).error);
  assert.deepEqual(fwdCallFor({ kind: 'draft.mark', flow: 'f', draft_id: 'd', payload: { outcome: 'declined' } }), {
    path: '/supervisor/flows/f/drafts/d/mark',
    body: { outcome: 'declined' },
  });
  assert.equal(fwdCallFor({ kind: 'draft.mark', flow: 'f', draft_id: 'd', payload: { outcome: 'send' } }), null);
});
