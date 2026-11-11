// Hosted /v1/plugin for FlowWeb and Frequency (Vercel Function). See docs/api/FREQUENCY-INTEGRATION-V1.md.
//
// Two kinds of caller:
//   - A signed-in FlowWeb owner or admin links their business to a Frequency Space, lists, pauses,
//     rotates or revokes that link. Their own Supabase token goes to PostgREST; the database checks roles.
//   - Frequency's server sends funnel events for a linked Space, signed with that link's secret.
//     This route checks the shape and the headers, then hands the raw body to fw_plugin_ingest, which
//     checks the signature inside the database. The site holds no service key and never sees the secret
//     after it is shown once.
import { HEADERS, parseEvent } from '../hosted/server/frequency-link.mjs';
import { routeOfUrl } from '../hosted/server/mirror.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 16384;
const LINK_COLUMNS = 'id,account_id,space_id,house,status,created_at,rotated_at,last_event_at';

const SUPABASE_URL = () => (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const ANON_KEY = () => process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const err = (status, code, message, details = {}) => json(status, { error: { code, message, details } });
const ok = (status, data) => json(status, { data, as_of: new Date().toISOString() });

async function supa(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL()}${path}`, {
    method,
    headers: {
      apikey: ANON_KEY(),
      authorization: `Bearer ${token || ANON_KEY()}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

function bearer(request) {
  const h = request.headers.get('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** A database refusal, said in plain words. */
function refused(r, what) {
  const code = r.data?.code ?? '';
  const msg = String(r.data?.message ?? '');
  if (code === '42501' || r.status === 401 || r.status === 403)
    return err(403, 'forbidden', `Only an owner or admin of this business can ${what}.`);
  if (code === '23505') return err(409, 'conflict', msg || 'That business or Space is already linked.');
  if (code === '42704') return err(404, 'not_found', 'No such link.');
  if (code === '22023') return err(400, 'validation_failed', msg || 'That value is not allowed.');
  return err(500, 'internal', `Could not ${what}.`);
}

/** Frequency's server sends one funnel event for a linked Space. */
async function receiveEvent(request, linkId) {
  const h = (name) => request.headers.get(name) ?? '';
  const ts = h(HEADERS.timestamp);
  const sig = h(HEADERS.signature);
  if (!ts || !sig) return json(401, { error: { code: 'unauthorized', reason: 'unsigned' } });
  if (h(HEADERS.link) !== linkId) return json(401, { error: { code: 'unauthorized', reason: 'unknown_link' } });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: { code: 'too_large', reason: 'bad_event' } });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: { code: 'validation_failed', reason: 'bad_event', message: 'Body is not JSON.' } });
  }
  const parsed = parseEvent(body);
  if (!parsed.ok)
    return json(400, { error: { code: 'validation_failed', reason: 'bad_event', message: parsed.reason } });

  const r = await supa('/rest/v1/rpc/fw_plugin_ingest', {
    method: 'POST',
    body: { p_link: linkId, p_ts: ts, p_body: raw, p_signature: sig },
  });
  if (r.ok) return json(202, { data: { id: r.data, type: body.type } });
  const reason = String(r.data?.message ?? '');
  if (reason === 'paused') return json(403, { error: { code: 'forbidden', reason } });
  if (['unknown_link', 'stale', 'bad_signature'].includes(reason))
    return json(401, { error: { code: 'unauthorized', reason } });
  if (reason === 'bad_event') return json(400, { error: { code: 'validation_failed', reason } });
  if (reason === 'too_many_waiting') return json(429, { error: { code: 'rate_limited', reason } });
  return err(502, 'internal', 'Could not store that event.');
}

async function handle(request) {
  const method = request.method.toUpperCase();
  const { path } = routeOfUrl(request.url);
  if (!SUPABASE_URL() || !ANON_KEY()) return err(503, 'not_configured', 'The hosted site is not connected to its database.');

  const ev = path.match(/^\/links\/([^/]+)\/events$/);
  if (ev) {
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Send events with POST.');
    if (!UUID.test(ev[1])) return json(401, { error: { code: 'unauthorized', reason: 'unknown_link' } });
    return receiveEvent(request, ev[1]);
  }

  const token = bearer(request);
  if (!token) return err(401, 'unauthorized', 'Sign in first.');
  const u = await supa('/auth/v1/user', { token });
  if (!u.ok || !u.data?.email) return err(401, 'unauthorized', 'Your sign-in has expired.');

  if (path === '/links' && method === 'GET') {
    const r = await supa(`/rest/v1/fw_frequency_links?select=${LINK_COLUMNS}&order=created_at`, { token });
    if (!r.ok) return err(500, 'internal', 'Could not read your Frequency links.');
    return ok(200, r.data);
  }
  if (path === '/links' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const account = String(body?.account ?? '');
    const space = String(body?.space_id ?? '');
    if (!UUID.test(account)) return err(400, 'validation_failed', 'Say which business to link (account).');
    if (!SPACE_RE.test(space)) return err(400, 'validation_failed', 'space_id must be the Frequency Space id.');
    const r = await supa('/rest/v1/rpc/fw_create_frequency_link', {
      token,
      method: 'POST',
      body: { p_account: account, p_space_id: space, p_house: body?.house === true },
    });
    if (!r.ok) return refused(r, 'link this business to a Space');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return ok(201, {
      id: row?.link_id,
      space_id: space,
      secret: row?.secret,
      note: 'Copy this secret into Frequency now. It is not shown again; rotate the link if it is lost.',
    });
  }

  const one = path.match(/^\/links\/([^/]+)(\/rotate)?$/);
  if (one && UUID.test(one[1])) {
    if (one[2] && method === 'POST') {
      const r = await supa('/rest/v1/rpc/fw_rotate_frequency_link', { token, method: 'POST', body: { p_link: one[1] } });
      if (!r.ok) return refused(r, 'rotate this link');
      return ok(200, { id: one[1], secret: r.data, note: 'The old secret stopped working just now.' });
    }
    if (!one[2] && method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const status = String(body?.status ?? '');
      if (!['active', 'paused', 'revoked'].includes(status))
        return err(400, 'validation_failed', 'status must be active, paused or revoked.');
      const r = await supa('/rest/v1/rpc/fw_set_frequency_link_status', {
        token,
        method: 'POST',
        body: { p_link: one[1], p_status: status },
      });
      if (!r.ok) return refused(r, 'change this link');
      return ok(200, { id: one[1], status });
    }
  }
  return err(404, 'not_found', 'No such plugin route.');
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
