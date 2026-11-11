// Probe for FW-C-100 (FlowWeb and Frequency sign, check and hand people over to each other per linked
// Space, with one contract both sides share): `pnpm probe hosted/frequency-contract`.
// probe-timeout-s: 30
// Tier 0.
// Surfaces: hosted/server/frequency-link.mjs (pure: no network, no database, no env) and
// docs/api/FREQUENCY-INTEGRATION-V1.md.
//
// The surface this probe expects:
//   frequency-link.mjs exports
//     HEADERS { link: 'x-flowweb-link', signature: 'x-flowweb-signature', timestamp: 'x-flowweb-timestamp' }
//     sign(secret, ts, body) -> hex HMAC-SHA256 of `${ts}.${body}` (today's flowweb-claim scheme)
//     signedHeaders({ secret, link, body, now }) -> the three headers (no link header when link is null)
//     verify({ headers, body, now, secretFor, globalSecret }) -> { ok: true, link } | { ok: false, reason }
//       secretFor(linkId) -> { secret, status: 'active' | 'paused' } | null. A request with the link header
//       is checked only against that link's secret; one without it only against globalSecret (link null).
//       Reasons: 'unsigned', 'stale' (more than 300 s from now either way), 'unknown_link', 'paused',
//       'bad_signature'. Header names are matched case-insensitively.
//     mintHandoff({ secret, link, claims: { space_id, profile_id, email, space_role, owner }, nonce, now })
//       -> a token string valid for 60 s
//     readHandoff(token, { secretFor, now, useNonce }) -> { ok: true, link, claims, role } | { ok: false, reason }
//       useNonce(nonce) -> true the first time, false after. Reasons include 'expired', 'replayed',
//       'bad_signature', 'unknown_link', 'paused', 'malformed', 'no_role'.
//     fwRoleFor(space_role, { owner, viewers }) -> 'owner' | 'admin' | 'helper' | 'viewer' | null
//       owner -> owner; admin -> admin; moderator, editor -> helper; viewer -> viewer only when viewers is
//       true, else null; anything unknown -> null.
//     EVENT_TYPES: the eleven funnel events agreed with the launch funnels plan (v2 adds event.published).
//     parseEvent(body) -> { ok: true, event } | { ok: false, reason }: needs type in EVENT_TYPES, at (ISO
//       date), space_id; host_id and ref optional strings; only the extra fields its type allows are kept.
//     splitRef(utm_content) -> { niche, tag }: 'yoga.d_abc' -> { niche: 'yoga', tag: 'd_abc' }; a value with
//       no dot is all tag, niche null.
//   The contract doc names every header, route and event type above.
//
// Proves, in order:
//   1. A body signed for a link verifies against that link and no other secret; the global fallback still
//      works with no link header, and a link header never falls back to the global secret.
//   2. Stale, unsigned, unknown, paused and tampered requests are refused with their reason.
//   3. A handoff token works once, within 60 s, for an active link, and carries the mapped FlowWeb role.
//   4. Roles map as the plan says, and a Space viewer gets nothing unless the owner allows viewers.
//   5. Funnel events parse, unknown types and missing fields are refused, and extra fields are dropped.
//   6. utm_content splits on its first dot.
//   7. The contract doc names the headers, routes and every event type.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, missing, probe } from '../c0/_lib.mjs';

const NAME = 'hosted/frequency-contract';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = join(ROOT, 'hosted', 'server', 'frequency-link.mjs');
const DOC = join(ROOT, 'docs', 'api', 'FREQUENCY-INTEGRATION-V1.md');
const LINK_A = 'fwl_probe_a';
const LINK_B = 'fwl_probe_b';
const SECRET_A = 'probe-secret-a-not-real-0123456789';
const SECRET_B = 'probe-secret-b-not-real-0123456789';
const SECRET_P = 'probe-secret-p-not-real-0123456789';
const GLOBAL = 'probe-global-not-real-0123456789';
const NOW = Date.parse('2026-11-11T18:00:00Z');

const links = {
  [LINK_A]: { secret: SECRET_A, status: 'active' },
  [LINK_B]: { secret: SECRET_B, status: 'active' },
  fwl_probe_paused: { secret: SECRET_P, status: 'paused' },
};
const secretFor = (id) => links[id] ?? null;

await probe(NAME, async () => {
  if (!existsSync(MOD)) missing(`hosted/server/frequency-link.mjs does not exist`);
  const m = await import(pathToFileURL(MOD).href);
  for (const name of ['sign', 'signedHeaders', 'verify', 'mintHandoff', 'readHandoff', 'fwRoleFor', 'parseEvent', 'splitRef']) {
    if (typeof m[name] !== 'function') missing(`frequency-link.mjs does not export ${name}()`);
  }
  if (!m.HEADERS || !Array.isArray(m.EVENT_TYPES)) missing('frequency-link.mjs does not export HEADERS and EVENT_TYPES');
  check(m.HEADERS.link === 'x-flowweb-link', 'HEADERS.link is x-flowweb-link');
  check(m.HEADERS.signature === 'x-flowweb-signature', 'HEADERS.signature is x-flowweb-signature');
  check(m.HEADERS.timestamp === 'x-flowweb-timestamp', 'HEADERS.timestamp is x-flowweb-timestamp');

  // 1. Signing and the per-link secret.
  const body = JSON.stringify({ type: 'host.started', at: '2026-11-11T17:59:00Z', space_id: 'sp_1' });
  const ts = String(Math.floor(NOW / 1000));
  const expect = createHmac('sha256', SECRET_A).update(`${ts}.${body}`).digest('hex');
  check(m.sign(SECRET_A, ts, body) === expect, 'sign() is hex HMAC-SHA256 of `${ts}.${body}`');

  const hA = m.signedHeaders({ secret: SECRET_A, link: LINK_A, body, now: NOW });
  check(hA['x-flowweb-link'] === LINK_A && hA['x-flowweb-signature'] === expect && hA['x-flowweb-timestamp'] === ts,
    'signedHeaders() carries the link, the signature and the timestamp in seconds');
  const ok = m.verify({ headers: hA, body, now: NOW, secretFor, globalSecret: GLOBAL });
  check(ok.ok === true && ok.link === LINK_A, `a request signed for its link verifies (got ${JSON.stringify(ok)})`);

  const upper = Object.fromEntries(Object.entries(hA).map(([k, v]) => [k.toUpperCase(), v]));
  check(m.verify({ headers: upper, body, now: NOW, secretFor, globalSecret: GLOBAL }).ok === true,
    'header names match case-insensitively');

  const wrongLink = { ...hA, 'x-flowweb-link': LINK_B };
  const wl = m.verify({ headers: wrongLink, body, now: NOW, secretFor, globalSecret: GLOBAL });
  check(wl.ok === false && wl.reason === 'bad_signature', 'a signature made with link A is refused as link B');

  const hG = m.signedHeaders({ secret: GLOBAL, link: null, body, now: NOW });
  check(!('x-flowweb-link' in hG), 'no link means no link header');
  const g = m.verify({ headers: hG, body, now: NOW, secretFor, globalSecret: GLOBAL });
  check(g.ok === true && g.link === null, 'with no link header the global secret still verifies (link null)');

  const linkWithGlobal = m.signedHeaders({ secret: GLOBAL, link: LINK_A, body, now: NOW });
  const lg = m.verify({ headers: linkWithGlobal, body, now: NOW, secretFor, globalSecret: GLOBAL });
  check(lg.ok === false && lg.reason === 'bad_signature', 'a link header never falls back to the global secret');

  const noGlobal = m.verify({ headers: hG, body, now: NOW, secretFor, globalSecret: '' });
  check(noGlobal.ok === false, 'with no global secret set, an unlinked request is refused');

  // 2. Refusals.
  const reason = (headers, b = body, now = NOW) => m.verify({ headers, body: b, now, secretFor, globalSecret: GLOBAL }).reason;
  check(reason({}) === 'unsigned', 'no signature: unsigned');
  check(reason(hA, body, NOW + 301_000) === 'stale', 'more than 300 s later: stale');
  check(reason(hA, body, NOW - 301_000) === 'stale', 'more than 300 s early: stale');
  check(reason(hA, body, NOW + 299_000) === undefined, 'within 300 s still verifies');
  check(reason(m.signedHeaders({ secret: SECRET_A, link: 'fwl_nope', body, now: NOW })) === 'unknown_link', 'unknown link: unknown_link');
  check(reason(m.signedHeaders({ secret: SECRET_P, link: 'fwl_probe_paused', body, now: NOW })) === 'paused', 'paused link: paused');
  check(reason(hA, body.replace('sp_1', 'sp_2')) === 'bad_signature', 'tampered body: bad_signature');

  // 3. Handoff.
  const used = new Set();
  const useNonce = (n) => (used.has(n) ? false : (used.add(n), true));
  const claims = { space_id: 'sp_1', profile_id: 'pr_1', email: 'host@example.com', space_role: 'moderator', owner: false };
  const tok = m.mintHandoff({ secret: SECRET_A, link: LINK_A, claims, nonce: 'n1', now: NOW });
  check(typeof tok === 'string' && tok.length > 20, 'mintHandoff() returns a token string');
  const r1 = m.readHandoff(tok, { secretFor, now: NOW + 5_000, useNonce });
  check(r1.ok === true && r1.link === LINK_A && r1.claims.email === 'host@example.com' && r1.role === 'helper',
    `a fresh token reads once with its link, claims and role (got ${JSON.stringify(r1)})`);
  check(m.readHandoff(tok, { secretFor, now: NOW + 6_000, useNonce }).reason === 'replayed', 'the same token twice: replayed');
  const t2 = m.mintHandoff({ secret: SECRET_A, link: LINK_A, claims, nonce: 'n2', now: NOW });
  check(m.readHandoff(t2, { secretFor, now: NOW + 61_000, useNonce }).reason === 'expired', 'after 60 s: expired');
  const t3 = m.mintHandoff({ secret: SECRET_B, link: LINK_A, claims, nonce: 'n3', now: NOW });
  check(m.readHandoff(t3, { secretFor, now: NOW, useNonce }).reason === 'bad_signature', 'signed with another secret: bad_signature');
  const t4 = m.mintHandoff({ secret: SECRET_P, link: 'fwl_probe_paused', claims, nonce: 'n4', now: NOW });
  check(m.readHandoff(t4, { secretFor, now: NOW, useNonce }).reason === 'paused', 'a paused link hands nobody over');
  check(m.readHandoff('not-a-token', { secretFor, now: NOW, useNonce }).reason === 'malformed', 'garbage: malformed');
  const t5 = m.mintHandoff({ secret: SECRET_A, link: LINK_A, claims: { ...claims, space_role: 'viewer' }, nonce: 'n5', now: NOW });
  check(m.readHandoff(t5, { secretFor, now: NOW, useNonce }).reason === 'no_role', 'a plain Space viewer is not let in by default');

  // 4. Roles.
  check(m.fwRoleFor('admin', { owner: true }) === 'owner', 'the Space owner is the FlowWeb owner');
  check(m.fwRoleFor('admin', {}) === 'admin', 'admin -> admin');
  check(m.fwRoleFor('moderator', {}) === 'helper' && m.fwRoleFor('editor', {}) === 'helper', 'moderator, editor -> helper');
  check(m.fwRoleFor('viewer', {}) === null && m.fwRoleFor('viewer', { viewers: true }) === 'viewer', 'viewer only when allowed');
  check(m.fwRoleFor('janitor', {}) === null && m.fwRoleFor(undefined, {}) === null, 'unknown roles get nothing');

  // 5. Events.
  const want = ['host.started', 'launcher.stalled', 'space.published', 'event.filled', 'event.rsvps_8', 'event.second',
    'meter.80', 'host.opted_out', 'founding.purchased', 'showcase.consent', 'event.published'];
  for (const t of want) check(m.EVENT_TYPES.includes(t), `EVENT_TYPES has ${t}`);
  const e1 = m.parseEvent({ type: 'event.rsvps_8', at: '2026-11-11T17:00:00Z', space_id: 'sp_1', host_id: 'pr_1', ref: 'yoga.d_1',
    rsvps: 9, non_host_rsvps: 8, event_title: 'Sunday sound bath', password: 'x' });
  check(e1.ok === true && e1.event.rsvps === 9 && e1.event.event_title === 'Sunday sound bath' && !('password' in e1.event),
    'an event keeps its own fields and drops the rest');
  const e2 = m.parseEvent({ type: 'event.published', at: '2026-11-11T17:00:00Z', space_id: 'sp_1', event_id: 'ev_1',
    title: 'Ecstatic dance', starts_at: '2026-11-15T19:00:00Z', town: 'Encinitas', niche: 'dance', rsvp_url: 'https://example.com/e/1' });
  check(e2.ok === true && e2.event.event_id === 'ev_1' && e2.event.rsvp_url === 'https://example.com/e/1' && e2.event.starts_at,
    'event.published keeps event_id, title, starts_at, town, niche and rsvp_url');
  check(m.parseEvent({ type: 'made.up', at: '2026-11-11T17:00:00Z', space_id: 'sp_1' }).ok === false, 'unknown type refused');
  check(m.parseEvent({ type: 'host.started', space_id: 'sp_1' }).ok === false, 'missing at refused');
  check(m.parseEvent({ type: 'host.started', at: 'yesterday', space_id: 'sp_1' }).ok === false, 'a bad date refused');
  check(m.parseEvent({ type: 'host.started', at: '2026-11-11T17:00:00Z' }).ok === false, 'missing space_id refused');

  // 6. utm_content.
  const s1 = m.splitRef('yoga.d_abc');
  check(s1.niche === 'yoga' && s1.tag === 'd_abc', 'niche.tag splits on the dot');
  const s2 = m.splitRef('d_abc');
  check(s2.niche === null && s2.tag === 'd_abc', 'no dot: all tag');
  const s3 = m.splitRef('sound.d_a.b');
  check(s3.niche === 'sound' && s3.tag === 'd_a.b', 'only the first dot splits');

  // 7. The contract doc.
  if (!existsSync(DOC)) missing('docs/api/FREQUENCY-INTEGRATION-V1.md does not exist');
  const doc = readFileSync(DOC, 'utf8');
  for (const s of ['x-flowweb-link', 'x-flowweb-signature', 'x-flowweb-timestamp', '/v1/plugin/links', '/v1/plugin/handoff', 'upcoming', 'facts', ...want]) {
    check(doc.includes(s), `the contract doc names ${s}`);
  }
});
