// The FlowWeb and Frequency contract in code (FW-C-100, docs/api/FREQUENCY-INTEGRATION-V1.md). Pure: no network,
// no database, no env. Every signed call either way, the one-time handoff token behind Open in FlowWeb, the
// Space role to FlowWeb role map, the funnel events Frequency pushes and the utm_content split all live here, so
// the routes that use them stay thin and both sides read one definition.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const HEADERS = Object.freeze({
  link: 'x-flowweb-link',
  signature: 'x-flowweb-signature',
  timestamp: 'x-flowweb-timestamp',
});

/** How far a signed timestamp may sit from now, either way. */
export const MAX_SKEW_S = 300;
/** How long a handoff token lives. */
export const HANDOFF_TTL_S = 60;

/** Hex HMAC-SHA256 of `${ts}.${body}`: today's flowweb-claim scheme, unchanged. */
export function sign(secret, ts, body) {
  return createHmac('sha256', String(secret)).update(`${ts}.${body}`).digest('hex');
}

/** The headers for one signed call. No link means no link header (the house's global secret). */
export function signedHeaders({ secret, link = null, body, now = Date.now() }) {
  const ts = String(Math.floor(now / 1000));
  const out = { [HEADERS.timestamp]: ts, [HEADERS.signature]: sign(secret, ts, body) };
  if (link) out[HEADERS.link] = String(link);
  return out;
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v ?? '');
  return '';
}

function sameHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Check one signed call. A request naming a link is checked only against that link's secret; one without a
 * link header only against globalSecret. secretFor(linkId) -> { secret, status } | null.
 */
export function verify({ headers, body, now = Date.now(), secretFor, globalSecret = '' }) {
  const sig = header(headers, HEADERS.signature);
  const ts = header(headers, HEADERS.timestamp);
  if (!sig || !/^\d+$/.test(ts)) return { ok: false, reason: 'unsigned' };
  if (Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_S) return { ok: false, reason: 'stale' };
  const link = header(headers, HEADERS.link) || null;
  let secret = '';
  if (link) {
    const found = typeof secretFor === 'function' ? secretFor(link) : null;
    if (!found?.secret) return { ok: false, reason: 'unknown_link' };
    if (found.status !== 'active') return { ok: false, reason: 'paused' };
    secret = found.secret;
  } else {
    secret = String(globalSecret ?? '');
    if (!secret) return { ok: false, reason: 'unknown_link' };
  }
  if (!sameHex(sig, sign(secret, ts, String(body ?? '')))) return { ok: false, reason: 'bad_signature' };
  return { ok: true, link };
}

// ── Roles ────────────────────────────────────────────────────────────────────────────────────────────────

const ROLE_MAP = Object.freeze({ admin: 'admin', moderator: 'helper', editor: 'helper' });

/** A Frequency Space role as a FlowWeb role, or null for no access. */
export function fwRoleFor(spaceRole, { owner = false, viewers = false } = {}) {
  if (owner) return 'owner';
  if (spaceRole === 'viewer') return viewers ? 'viewer' : null;
  return ROLE_MAP[spaceRole] ?? null;
}

// ── Handoff ──────────────────────────────────────────────────────────────────────────────────────────────

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

/** The one-time token Frequency's server mints for Open in FlowWeb: `<payload>.<signature>`. */
export function mintHandoff({ secret, link, claims, nonce, now = Date.now(), viewers = false }) {
  const iat = Math.floor(now / 1000);
  const payload = b64(JSON.stringify({ link, nonce, iat, exp: iat + HANDOFF_TTL_S, viewers: Boolean(viewers), claims }));
  return `${payload}.${sign(secret, 'handoff', payload)}`;
}

/** Read a handoff token. useNonce(nonce) -> true the first time it is seen, false after. */
export function readHandoff(token, { secretFor, now = Date.now(), useNonce }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  let p;
  try {
    p = JSON.parse(unb64(parts[0]));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!p || typeof p !== 'object' || !p.link || !p.nonce || !p.claims) return { ok: false, reason: 'malformed' };
  const found = typeof secretFor === 'function' ? secretFor(p.link) : null;
  if (!found?.secret) return { ok: false, reason: 'unknown_link' };
  if (!sameHex(parts[1], sign(found.secret, 'handoff', parts[0]))) return { ok: false, reason: 'bad_signature' };
  if (found.status !== 'active') return { ok: false, reason: 'paused' };
  if (!(Number(p.exp) >= now / 1000)) return { ok: false, reason: 'expired' };
  if (typeof useNonce !== 'function' || !useNonce(String(p.nonce))) return { ok: false, reason: 'replayed' };
  const role = fwRoleFor(p.claims.space_role, { owner: Boolean(p.claims.owner), viewers: Boolean(p.viewers) });
  if (!role) return { ok: false, reason: 'no_role' };
  return { ok: true, link: p.link, claims: p.claims, role };
}

// ── Funnel events (Frequency to FlowWeb) ─────────────────────────────────────────────────────────────────

const EVENT_FIELDS = Object.freeze({
  'host.started': ['niche', 'town', 'first_name'],
  'launcher.stalled': ['step', 'idle', 'first_name'],
  'space.published': ['detail', 'first_name'],
  'event.filled': ['event_title'],
  'event.rsvps_8': ['rsvps', 'non_host_rsvps', 'event_title'],
  'event.second': [],
  'meter.80': ['meter', 'used', 'limit'],
  'host.opted_out': [],
  'founding.purchased': [],
  'showcase.consent': ['on'],
  'event.published': ['event_id', 'title', 'starts_at', 'town', 'niche', 'rsvp_url'],
});

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_FIELDS));

const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

/** Check one pushed event and keep only the fields its type carries. */
export function parseEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'not an object' };
  const fields = EVENT_FIELDS[body.type];
  if (!fields) return { ok: false, reason: 'unknown type' };
  if (!isDate(body.at)) return { ok: false, reason: 'at must be an ISO date' };
  if (typeof body.space_id !== 'string' || !body.space_id) return { ok: false, reason: 'space_id is required' };
  const event = { type: body.type, at: body.at, space_id: body.space_id };
  for (const k of ['host_id', 'ref']) if (typeof body[k] === 'string' && body[k]) event[k] = body[k];
  for (const k of fields) if (body[k] !== undefined && body[k] !== null) event[k] = body[k];
  return { ok: true, event };
}

/** utm_content is `niche.tag`; split on the first dot. No dot: all tag. */
export function splitRef(value) {
  const s = String(value ?? '');
  const i = s.indexOf('.');
  return i < 0 ? { niche: null, tag: s } : { niche: s.slice(0, i) || null, tag: s.slice(i + 1) };
}
