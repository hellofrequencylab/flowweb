import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvent, readHandoff, mintHandoff, signedHeaders, splitRef, verify } from '../server/frequency-link.mjs';

const NOW = Date.parse('2026-11-11T18:00:00Z');
const links = { fwl_a: { secret: 'a-not-real', status: 'active' } };
const secretFor = (id) => links[id] ?? null;

test('a fetch Headers object verifies like a plain one', () => {
  const body = '{"x":1}';
  const h = new Headers(signedHeaders({ secret: 'a-not-real', link: 'fwl_a', body, now: NOW }));
  assert.deepEqual(verify({ headers: h, body, now: NOW, secretFor }), { ok: true, link: 'fwl_a' });
});

test('a signature of the wrong length is refused, not thrown', () => {
  const h = { ...signedHeaders({ secret: 'a-not-real', link: 'fwl_a', body: '{}', now: NOW }), 'x-flowweb-signature': 'ab' };
  assert.equal(verify({ headers: h, body: '{}', now: NOW, secretFor }).reason, 'bad_signature');
});

test('a token whose payload was edited no longer matches its signature', () => {
  const tok = mintHandoff({ secret: 'a-not-real', link: 'fwl_a', nonce: 'n', now: NOW,
    claims: { space_id: 's', profile_id: 'p', email: 'e@example.com', space_role: 'editor', owner: false } });
  const [payload, sig] = tok.split('.');
  const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
  p.claims.owner = true;
  const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${sig}`;
  assert.equal(readHandoff(forged, { secretFor, now: NOW, useNonce: () => true }).reason, 'bad_signature');
});

test('first_name rides host events only', () => {
  const base = { at: '2026-11-11T17:00:00Z', space_id: 's', first_name: 'Ana' };
  assert.equal(parseEvent({ ...base, type: 'host.started' }).event.first_name, 'Ana');
  assert.equal('first_name' in parseEvent({ ...base, type: 'event.filled' }).event, false);
});

test('an empty niche before the dot reads as no niche', () => {
  assert.deepEqual(splitRef('.d_1'), { niche: null, tag: 'd_1' });
});
