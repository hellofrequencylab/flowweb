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

test('FW-C-124: a flow copy carries only name, note and slug, and the relay maps it back', () => {
  const r = requestOf('POST', '/supervisor/flows/neighborhood-activation/copy', { name: ' Austin ', slug: 'austin', extra: 1 });
  assert.deepEqual(r, { kind: 'flow.copy', flow: 'neighborhood-activation', draft_id: null, payload: { name: 'Austin', slug: 'austin' } });
  assert.deepEqual(fwdCallFor({ id: 'r1', ...r }), {
    method: 'POST',
    path: '/supervisor/flows/neighborhood-activation/copy',
    body: { name: 'Austin', slug: 'austin' },
  });
  assert.ok(requestOf('POST', '/supervisor/flows/paid-ads/copy', { slug: 'Bad Slug' }).error);
  assert.ok(requestOf('POST', '/supervisor/flows/paid-ads/copy', { note: 'x'.repeat(501) }).error);
  assert.equal(requestOf('GET', '/supervisor/flows/paid-ads/copy', {}), null);
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

test('FW-C-151 stages only a validated opted-in email template through the relay', () => {
  const path = '/flows/email-queue/drafts';
  const body = {
    asset: 'reengagement-14-day',
    subject: 'A note from Frequency',
    preheader: 'A few updates for you',
    body: 'Here is what is new.',
    audience: 'subscribed_members',
  };
  const request = requestOf('POST', path, body);
  assert.deepEqual(request, {
    kind: 'email-queue.stage',
    flow: 'email-queue',
    draft_id: null,
    payload: body,
  });
  assert.deepEqual(fwdCallFor(request), {
    method: 'POST',
    path,
    body,
  });

  const boundaryBody = {
    asset: 'a'.repeat(48),
    subject: 's'.repeat(200),
    preheader: 'p'.repeat(200),
    body: 'b'.repeat(10_000),
    audience: 'subscribed_members',
  };
  assert.deepEqual(requestOf('POST', path, boundaryBody).payload, boundaryBody);

  const withoutPreheader = { ...body };
  delete withoutPreheader.preheader;
  assert.deepEqual(requestOf('POST', path, withoutPreheader).payload, withoutPreheader);
  assert.equal(requestOf('GET', path, body), null);
  assert.equal(requestOf('POST', '/flows/neighborhood-activation/drafts', body), null);
  assert.equal(requestOf('POST', '/flows/email-queue/send', body), null);
  assert.equal(requestOf('POST', '/flows/email-queue/schedule', body), null);
  assert.equal(requestOf('POST', '/flows/email-queue/drafts/approve', body), null);
  assert.match(
    requestOf('POST', '/supervisor/flows/email-queue/schedule', { time: '09:00', days: 'daily' }).error,
    /cannot be scheduled/,
  );
});

test('FW-C-151 refuses invalid, unsupported, oversized or action-bearing email requests', () => {
  const path = '/flows/email-queue/drafts';
  const body = {
    asset: 'whats-new',
    subject: 'A note from Frequency',
    body: 'Here is what is new.',
    audience: 'subscribed_members',
  };
  const invalid = [
    [{ ...body, audience: 'all_contacts' }, /audience/],
    [{ ...body, asset: 'Bad Asset' }, /asset/],
    [{ ...body, asset: 'a'.repeat(49) }, /asset/],
    [{ ...body, subject: ' ' }, /subject/],
    [{ ...body, subject: 's'.repeat(201) }, /subject/],
    [{ ...body, preheader: '' }, /preheader/],
    [{ ...body, preheader: 'p'.repeat(201) }, /preheader/],
    [{ ...body, body: '' }, /body/],
    [{ ...body, body: 'b'.repeat(10_001) }, /body/],
    [{ ...body, send: true }, /unsupported field/],
    [{ ...body, scheduled_at: '2026-11-12T09:00:00-08:00' }, /unsupported field/],
    [{ ...body, provider: 'gmail' }, /unsupported field/],
    [{ ...body, extra: 'ignored fields are not accepted' }, /unsupported field/],
    [{ asset: body.asset, subject: body.subject, audience: body.audience }, /body/],
  ];
  for (const [candidate, message] of invalid) {
    const result = requestOf('POST', path, candidate);
    assert.match(result.error, message, JSON.stringify(candidate));
  }
  assert.match(requestOf('POST', path, []).error, /object/);
  assert.equal(
    fwdCallFor({
      kind: 'email-queue.stage',
      flow: 'email-queue',
      draft_id: null,
      payload: { ...body, audience: 'all_contacts' },
    }),
    null,
  );
  assert.equal(
    fwdCallFor({ kind: 'email-queue.stage', flow: 'email-queue', draft_id: body.asset, payload: body }),
    null,
  );
  assert.equal(
    fwdCallFor({ kind: 'email-queue.stage', flow: 'neighborhood-activation', draft_id: null, payload: body }),
    null,
  );
  assert.equal(
    fwdCallFor({ kind: 'email.send', flow: 'email-queue', draft_id: null, payload: body }),
    null,
  );
  assert.equal(
    fwdCallFor({ kind: 'email.schedule', flow: 'email-queue', draft_id: null, payload: body }),
    null,
  );
  assert.equal(
    fwdCallFor({
      kind: 'flow.schedule',
      flow: 'email-queue',
      payload: { time: '09:00', days: 'daily' },
    }),
    null,
  );
});

test('FW-C-151 requires sign-in and propagates the Owner-only queue refusal', async () => {
  const priorUrl = process.env.SUPABASE_URL;
  const priorKey = process.env.SUPABASE_ANON_KEY;
  const priorFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://flowweb-test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init.method ?? 'GET', authorization: init.headers?.authorization });
    if (url.pathname === '/auth/v1/user')
      return new Response(JSON.stringify({ email: 'member@example.test' }), { status: 200 });
    if (url.pathname === '/rest/v1/rpc/fw_my_accounts')
      return new Response(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', role: 'helper', flows: ['email-queue'] }]), {
        status: 200,
      });
    if (url.pathname === '/rest/v1/rpc/fw_request')
      return new Response(JSON.stringify({ code: '42501', message: 'Owner role required' }), { status: 403 });
    throw new Error(`unexpected Supabase request: ${url.pathname}`);
  };

  try {
    const { POST } = await import(`../../api/v1.mjs?fwc151-auth-test=${Date.now()}`);
    const endpoint = 'https://flowweb.test/api/v1?__p=flows/email-queue/drafts';
    const body = JSON.stringify({
      asset: 'whats-new',
      subject: 'A note from Frequency',
      body: 'Here is what is new.',
      audience: 'subscribed_members',
    });

    const unauthenticated = await POST(
      new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    );
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(calls, [], 'an unsigned request must not contact Supabase or queue work');

    const denied = await POST(
      new Request(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer test-user-token', 'content-type': 'application/json' },
        body,
      }),
    );
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'forbidden');
    assert.deepEqual(
      calls.map(({ path }) => path),
      ['/auth/v1/user', '/rest/v1/rpc/fw_my_accounts', '/rest/v1/rpc/fw_request'],
      'a denied non-Owner request must stop at the Owner-gated RPC, before relay or local draft handling',
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = priorKey;
  }
});
