import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftRequestOf, fwdCallFor, requestOf, senderHold } from '../server/requests.mjs';

const P = '/supervisor/flows/neighborhood-activation/drafts/hnt_1-a';

test('draft changes become draft requests; flow controls are not draft requests', () => {
  assert.equal(draftRequestOf('POST', `${P}/approve`, {}).kind, 'draft.approve');
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
  assert.deepEqual(fwdCallFor(r), { method: 'POST', path: `${P}/edit`, body: { body: 'B' } });
  assert.deepEqual(fwdCallFor({ ...r, kind: 'draft.approve' }), { method: 'POST', path: `${P}/approve`, body: {} });
  assert.equal(fwdCallFor({ ...r, kind: 'draft.send' }), null);
  assert.equal(fwdCallFor({ ...r, flow: '../x' }), null);
  assert.deepEqual(fwdCallFor({ ...r, kind: 'draft.reject' }), { method: 'POST', path: `${P}/reject`, body: {} });
});

test('a mark carries only a known outcome, and the relay maps it to the mark route', () => {
  assert.deepEqual(draftRequestOf('POST', `${P}/mark`, { outcome: 'replied', status: 'handed_off' }).payload, {
    outcome: 'replied',
  });
  assert.ok(draftRequestOf('POST', `${P}/mark`, {}).error);
  assert.ok(draftRequestOf('POST', `${P}/mark`, { outcome: 'approved' }).error);
  assert.deepEqual(fwdCallFor({ kind: 'draft.mark', flow: 'f', draft_id: 'd', payload: { outcome: 'declined' } }), {
    method: 'POST',
    path: '/supervisor/flows/f/drafts/d/mark',
    body: { outcome: 'declined' },
  });
  assert.equal(fwdCallFor({ kind: 'draft.mark', flow: 'f', draft_id: 'd', payload: { outcome: 'send' } }), null);
});

test('flow controls become requests, and Autopilot, the kill switch and budgets do not', () => {
  const S = '/supervisor/flows/neighborhood-activation';
  assert.deepEqual(requestOf('POST', `${S}/enable`, { x: 1 }), {
    kind: 'flow.enable',
    flow: 'neighborhood-activation',
    draft_id: null,
    payload: {},
  });
  assert.equal(requestOf('POST', '/supervisor/pause', {}).flow, 'all');
  assert.deepEqual(requestOf('POST', `${S}/dial`, { stop: 'copilot' }).payload, { stop: 'copilot' });
  assert.match(requestOf('POST', `${S}/dial`, { stop: 'autopilot' }).error, /Autopilot is set on your Mac/);
  assert.equal(requestOf('POST', '/kill-switch/release', {}), null);
  assert.equal(requestOf('POST', `${S}/budget`, {}), null);
  assert.equal(requestOf('GET', `${S}/enable`, {}), null);
  assert.ok(requestOf('POST', '/supervisor/flows/Bad Flow/run', {}).error);
});

test('hunts and do-not-contact become requests with only their own fields', () => {
  const F = '/flows/neighborhood-activation';
  const saved = requestOf('POST', `${F}/hunts`, { name: 'N', looking_for: 'L', region: 'r', every_days: 1, id: 'x' });
  assert.deepEqual(saved.payload, { name: 'N', looking_for: 'L', region: 'r', every_days: 1 });
  assert.ok(requestOf('POST', `${F}/hunts`, { name: 'N' }).error);
  assert.equal(requestOf('DELETE', `${F}/hunts/hnt_ab12`, undefined).kind, 'hunt.remove');
  assert.ok(requestOf('POST', `${F}/hunts/../run`, {}).error);
  assert.deepEqual(fwdCallFor(requestOf('DELETE', `${F}/hunts/hnt_ab12`)), {
    method: 'DELETE',
    path: `${F}/hunts/hnt_ab12`,
    body: undefined,
  });
  assert.deepEqual(requestOf('POST', `${F}/do-not-contact`, { lead_id: 'l1', reason: ' no ' }).payload, {
    lead_id: 'l1',
    reason: 'no',
  });
  assert.ok(requestOf('POST', `${F}/do-not-contact`, { email: 'a@b.c' }).error);
});

test('a morning run time and people a day become requests, checked like fwd checks them (FW-C-063)', () => {
  const S = '/supervisor/flows/neighborhood-activation';
  const sch = requestOf('POST', `${S}/schedule`, { time: '05:30', days: 'daily', sneaky: 1 });
  assert.deepEqual(sch, { kind: 'flow.schedule', flow: 'neighborhood-activation', draft_id: null, payload: { time: '05:30', days: 'daily' } });
  assert.deepEqual(fwdCallFor(sch), { method: 'POST', path: `${S}/schedule`, body: { time: '05:30', days: 'daily' } });
  const int = requestOf('POST', `${S}/intensity`, { per_day: 6 });
  assert.deepEqual(int.payload, { per_day: 6, auto: false, min: 1, max: 25 });
  assert.equal(fwdCallFor(int).path, `${S}/intensity`);
  for (const [path, body] of [
    [`${S}/schedule`, { time: '5:30', days: 'daily' }],
    [`${S}/schedule`, { time: '05:30', days: 'weekends' }],
    [`${S}/intensity`, { per_day: 0 }],
    [`${S}/intensity`, { per_day: 8, min: 9, max: 20 }],
    [`${S}/intensity`, { per_day: '8' }],
  ])
    assert.ok(requestOf('POST', path, body).error, `${path} ${JSON.stringify(body)} should be refused`);
  assert.equal(requestOf('GET', `${S}/schedule`, {}), null);
  assert.equal(fwdCallFor({ kind: 'flow.intensity', flow: 'neighborhood-activation', payload: { per_day: 99 } }), null);
});

test('FW-C-071: a site move to Copilot or Autopilot waits for a sender on the Mac', () => {
  const dial = (stop) => ({ kind: 'flow.dial', flow: 'neighborhood-activation', draft_id: null, payload: { stop } });
  const none = { installed: false, last_pass_at: null };
  const here = { installed: true, last_pass_at: '2026-11-10T17:40:00Z' };
  for (const stop of ['copilot', 'autopilot']) {
    assert.match(senderHold(dial(stop), none), /Needs a sender on your Mac/);
    assert.match(senderHold(dial(stop), undefined), /sender/);
    assert.equal(senderHold(dial(stop), here), null);
  }
  assert.equal(senderHold(dial('draft'), none), null);
  assert.equal(senderHold({ kind: 'draft.reject', flow: 'neighborhood-activation', payload: {} }, none), null);
});

test('the funnel links switch becomes links.funnels with only live, and the relay maps it back', () => {
  for (const live of [true, false, null]) {
    const r = requestOf('POST', '/supervisor/funnels-live', { live, other: 1 });
    assert.deepEqual(r, { kind: 'links.funnels', flow: 'all', draft_id: null, payload: { live } });
    assert.deepEqual(fwdCallFor(r), { method: 'POST', path: '/supervisor/funnels-live', body: { live } });
  }
  assert.ok(requestOf('POST', '/supervisor/funnels-live', { live: 'on' }).error);
  assert.ok(requestOf('POST', '/supervisor/funnels-live', {}).error);
  assert.equal(requestOf('GET', '/supervisor/funnels-live', {}), null);
  assert.equal(fwdCallFor({ kind: 'links.funnels', flow: 'all', payload: { live: 1 } }), null);
});

test('renaming an agent becomes team.edit with only name and voice, and the relay maps it back (FW-C-123)', () => {
  const r = requestOf('POST', '/team/frequency/ceo', { name: ' Nova ', other: 1 });
  assert.deepEqual(r, { kind: 'team.edit', flow: 'all', draft_id: null, payload: { team: 'frequency', role: 'ceo', name: 'Nova' } });
  assert.deepEqual(fwdCallFor(r), { method: 'POST', path: '/team/frequency/ceo', body: { name: 'Nova' } });
  assert.ok(requestOf('POST', '/team/frequency/ceo', {}).error);
  assert.ok(requestOf('POST', '/team/frequency/ceo', { voice: 'x'.repeat(201) }).error);
  assert.ok(requestOf('POST', '/team/Bad Team/ceo', { name: 'X' }).error);
  assert.equal(requestOf('GET', '/team/frequency/ceo', {}), null);
  assert.equal(fwdCallFor({ kind: 'team.edit', flow: 'all', payload: { team: 'main', role: 'ceo' } }), null);
});
