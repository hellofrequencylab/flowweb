#!/usr/bin/env node
// The hosted Owner request must reach only S9's draft endpoint. It must not expose an outbound action.
import assert from 'node:assert/strict';
import { fwdCallFor, requestOf } from '../../hosted/server/requests.mjs';

const path = '/flows/email-queue/drafts';
const payload = {
  asset: 'beta-reengagement-r1',
  subject: 'A lot has changed since you joined',
  preheader: 'Your Space can have its own website now.',
  body: 'Hello there. January 31, 2027.',
  audience: 'subscribed_members',
};

const request = requestOf('POST', path, payload);
assert.equal(request?.kind, 'email-queue.stage');
assert.equal(request.flow, 'email-queue');
assert.equal(request.draft_id, null);
assert.deepEqual(request.payload, payload);
assert.deepEqual(fwdCallFor(request), { method: 'POST', path, body: payload });

assert.equal(requestOf('GET', path, payload), null, 'staging is a write');
assert.equal(requestOf('POST', path.replace('email-queue', 'unknown-flow'), payload), null);
assert.ok(requestOf('POST', path, { ...payload, audience: 'members' })?.error);
assert.ok(requestOf('POST', path, { ...payload, asset: '../outside' })?.error);
assert.ok(requestOf('POST', path, { ...payload, body: ' ' })?.error);
assert.ok(requestOf('POST', path, { ...payload, body: 'x'.repeat(10_001) })?.error);

for (const kind of ['email.send', 'email.schedule', 'email.approve', 'draft.send']) {
  assert.equal(
    fwdCallFor({ kind, flow: 'email-queue', draft_id: null, payload }),
    null,
    `${kind} must not be a relay action`,
  );
}

console.log('FW-C-151 staging route and outbound-denial checks passed');
