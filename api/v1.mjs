// Hosted /v1 for the FlowWeb web UI (Vercel Function). See hosted/README.md.
//
// This is not fwd. It serves a read-only mirror of the Owner's local fwd, pushed by the relay.
// It holds no secrets: it forwards the signed-in Owner's own Supabase token to PostgREST, and
// row-level security decides what that token may read. Writes that only fwd can make (approve,
// kill switch, answer a card) are refused with 501 and a reason, never faked.
import { resolveRead } from '../hosted/server/mirror.mjs';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
const err = (status, code, message, details = {}) => json(status, { error: { code, message, details } });

function routeOf(request) {
  const url = new URL(request.url);
  const p = url.searchParams.get('__p') ?? '';
  url.searchParams.delete('__p');
  const path = `/${p}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return { path, params: url.searchParams };
}

function bearer(request) {
  const h = request.headers.get('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

async function supa(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      authorization: `Bearer ${token || ANON_KEY}`,
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

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function mirrorStore(token) {
  return {
    async lookup(keys) {
      const list = `(${keys.map(quote).join(',')})`;
      const r = await supa(`/rest/v1/fw_mirror?select=key,envelope&key=in.${encodeURIComponent(list)}`, {
        token,
      });
      if (!r.ok) throw new Error(`mirror read failed (${r.status})`);
      return new Map(r.data.map((x) => [x.key, x.envelope]));
    },
    async lookupPrefix(prefix) {
      const pat = encodeURIComponent(`${prefix}*`);
      const r = await supa(`/rest/v1/fw_mirror?select=key,envelope&key=like.${pat}&order=key`, { token });
      if (!r.ok) throw new Error(`mirror read failed (${r.status})`);
      return r.data.map((x) => [x.key, x.envelope]);
    },
  };
}

/** The signed-in user, if their token is valid and they are the Owner. */
async function owner(request) {
  const token = bearer(request);
  if (!token) return { error: err(401, 'unauthorized', 'Sign in first.') };
  const u = await supa('/auth/v1/user', { token });
  if (!u.ok || !u.data?.email) return { error: err(401, 'unauthorized', 'Your sign-in has expired.') };
  const o = await supa('/rest/v1/rpc/fw_is_owner', { token, method: 'POST', body: {} });
  if (!o.ok || o.data !== true)
    return { error: err(403, 'forbidden', 'This account is not the owner of this FlowWeb.') };
  return { token, user: u.data };
}

async function handle(request) {
  if (!SUPABASE_URL || !ANON_KEY)
    return err(500, 'internal', 'The hosted site is missing SUPABASE_URL or SUPABASE_ANON_KEY.');
  const { path, params } = routeOf(request);
  const method = request.method.toUpperCase();

  // Public: lets the relay find the database without being configured twice.
  if (method === 'GET' && path === '/hosted/config') {
    return json(200, { data: { supabase_url: SUPABASE_URL, anon_key: ANON_KEY } });
  }

  const me = await owner(request);
  if (me.error) return me.error;
  const { token, user } = me;

  if (path === '/session') {
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json(200, {
      data: { paired_at: user.last_sign_in_at ?? user.created_at, device_label: user.email },
      as_of: new Date().toISOString(),
      head_seq: null,
      next_cursor: null,
    });
  }

  if (path === '/hosted/machines' && method === 'GET') {
    const r = await supa(
      '/rest/v1/fw_runners?select=id,label,created_at,last_seen_at,report,revoked_at&order=created_at.desc',
      { token },
    );
    if (!r.ok) return err(500, 'internal', 'Could not read machines.');
    return json(200, { data: r.data, as_of: new Date().toISOString(), head_seq: null, next_cursor: null });
  }
  if (path === '/hosted/machines' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const r = await supa('/rest/v1/rpc/fw_create_runner_token', {
      token,
      method: 'POST',
      body: { p_label: String(body?.label ?? 'machine') },
    });
    if (!r.ok) return err(500, 'internal', 'Could not create a relay token.');
    if (typeof r.data !== 'string' || !r.data.startsWith('fwr_'))
      return err(500, 'internal', 'The relay token was not created.');
    return json(201, { data: { token: r.data }, as_of: new Date().toISOString(), head_seq: null, next_cursor: null });
  }
  const revoke = path.match(/^\/hosted\/machines\/([0-9a-f-]{36})\/revoke$/);
  if (revoke && method === 'POST') {
    const r = await supa('/rest/v1/rpc/fw_revoke_runner', { token, method: 'POST', body: { p_id: revoke[1] } });
    if (!r.ok) return err(500, 'internal', 'Could not revoke that machine.');
    return new Response(null, { status: 204 });
  }

  if (method !== 'GET') {
    return err(
      501,
      'not_implemented',
      'the live site is a read-only mirror; do this in FlowWeb on your machine (fwd), where it is recorded',
    );
  }
  if (path === '/events/stream') return err(501, 'not_implemented', 'no live stream on the mirror');
  if (/^\/evidence-bundles\/[^/]+\/diff$/.test(path))
    return err(404, 'not_found', 'Diffs stay on your machine; open this bundle in FlowWeb there.');

  try {
    const r = await resolveRead(path, params, mirrorStore(token));
    return json(r.status, r.body);
  } catch (e) {
    return err(502, 'internal', String(e?.message ?? e));
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
