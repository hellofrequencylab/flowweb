// Hosted /v1 for the FlowWeb web UI (Vercel Function). See hosted/README.md.
//
// This is not fwd. It serves a read-only mirror of the Owner's local fwd, pushed by the relay.
// It holds no secrets: it forwards the signed-in Owner's own Supabase token to PostgREST, and
// row-level security decides what that token may read. Writes that only fwd can make (approve,
// kill switch, answer a card) are refused with 501 and a reason, never faked. The exceptions are the
// draft changes and flow controls in hosted/server/requests.mjs: the site queues them and the relay on
// the Owner's machine applies them through fwd; the answer says it is queued, not done.
import { resolveRead, routeOfUrl } from '../hosted/server/mirror.mjs';
import { answerSetupQuestion } from '../hosted/server/assistant.mjs';
import { answerConsole } from '../hosted/server/console.mjs';
import { requestOf } from '../hosted/server/requests.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_SET = new Set(['owner', 'admin', 'helper', 'viewer']);
const FLOW_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
const err = (status, code, message, details = {}) => json(status, { error: { code, message, details } });

function routeOf(request) {
  return routeOfUrl(request.url);
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

function mirrorStore(token, account) {
  const acc = `account_id=eq.${account}`;
  return {
    async lookup(keys) {
      const list = `(${keys.map(quote).join(',')})`;
      const r = await supa(`/rest/v1/fw_mirror?select=key,envelope&${acc}&key=in.${encodeURIComponent(list)}`, {
        token,
      });
      if (!r.ok) throw new Error(`mirror read failed (${r.status})`);
      return new Map(r.data.map((x) => [x.key, x.envelope]));
    },
    async lookupPrefix(prefix) {
      const pat = encodeURIComponent(`${prefix}*`);
      const r = await supa(`/rest/v1/fw_mirror?select=key,envelope&${acc}&key=like.${pat}&order=key`, { token });
      if (!r.ok) throw new Error(`mirror read failed (${r.status})`);
      return r.data.map((x) => [x.key, x.envelope]);
    },
  };
}

/** The signed-in person, if their token is valid. */
async function signedIn(request) {
  const token = bearer(request);
  if (!token) return { error: err(401, 'unauthorized', 'Sign in first.') };
  const u = await supa('/auth/v1/user', { token });
  if (!u.ok || !u.data?.email) return { error: err(401, 'unauthorized', 'Your sign-in has expired.') };
  return { token, user: u.data };
}

/**
 * The business this request is about: the x-fw-account header, or the person's first business.
 * Naming one they are not in answers 403. The database checks membership again on every read.
 */
async function accountOf(request, token) {
  const r = await supa('/rest/v1/rpc/fw_my_accounts', { token, method: 'POST', body: {} });
  if (!r.ok || !Array.isArray(r.data)) return { error: err(500, 'internal', 'Could not read your businesses.') };
  const asked = request.headers.get('x-fw-account') ?? '';
  const mine = asked ? r.data.find((a) => a.id === asked) : r.data[0];
  if (asked && !mine) return { error: err(403, 'forbidden', 'You are not a member of that business.') };
  return { accounts: r.data, account: mine ?? null };
}

const ok = (status, data) => json(status, { data, as_of: new Date().toISOString(), head_seq: null, next_cursor: null });
const denied = (r, what) =>
  r.status === 401 || r.status === 403 || r.data?.code === '42501'
    ? err(403, 'forbidden', `Your role in this business cannot ${what}.`)
    : r.data?.code === '23514'
      ? err(409, 'conflict', 'A business needs at least one owner.')
      : r.data?.code === '22023'
        ? err(410, 'gone', 'That invite has been used, revoked or has expired. Ask for a new one.')
        : err(500, 'internal', `Could not ${what}.`);

const cleanFlows = (flows) =>
  Array.isArray(flows) && flows.length ? flows.filter((f) => typeof f === 'string' && FLOW_RE.test(f)) : null;

/** Accounts, members and invites (FW-C-083). Answers null when the path is not one of these. */
async function accountRoutes(request, method, path, token, account) {
  if (path === '/accounts' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 80) return err(400, 'validation_failed', 'Give the business a name (up to 80 characters).');
    const r = await supa('/rest/v1/rpc/fw_create_account', { token, method: 'POST', body: { p_name: name } });
    if (!r.ok) return denied(r, 'make a business');
    return ok(201, { id: r.data, name });
  }
  const accept = path.match(/^\/invites\/(fwi_[0-9a-f]{32,64})\/accept$/);
  if (accept && method === 'POST') {
    const r = await supa('/rest/v1/rpc/fw_accept_invite', { token, method: 'POST', body: { p_token: accept[1] } });
    if (!r.ok) return denied(r, 'use that invite');
    return ok(200, { account_id: r.data });
  }
  const m = path.match(/^\/accounts\/([0-9a-f-]{36})(\/.*)?$/);
  if (!m || !UUID.test(m[1])) return null;
  const acc = m[1];
  const rest = m[2] ?? '';
  if (rest === '' && method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 80) return err(400, 'validation_failed', 'Give the business a name (up to 80 characters).');
    const r = await supa('/rest/v1/rpc/fw_rename_account', { token, method: 'POST', body: { p_account: acc, p_name: name } });
    return r.ok ? ok(200, { id: acc, name }) : denied(r, 'rename the business');
  }
  if (rest === '' && method === 'DELETE') {
    const r = await supa('/rest/v1/rpc/fw_delete_account', { token, method: 'POST', body: { p_account: acc } });
    return r.ok ? new Response(null, { status: 204 }) : denied(r, 'delete the business');
  }
  if (rest === '/members' && method === 'GET') {
    const people = await supa(
      `/rest/v1/fw_members?select=user_id,email,role,flows,added_at&account_id=eq.${acc}&order=added_at`,
      { token },
    );
    if (!people.ok) return err(500, 'internal', 'Could not read members.');
    const inv = await supa(
      `/rest/v1/fw_invites?select=id,email,role,flows,created_at,expires_at&account_id=eq.${acc}&accepted_at=is.null&revoked_at=is.null&order=created_at.desc`,
      { token },
    );
    return ok(200, { members: people.data, invites: inv.ok ? inv.data : [], role: account?.id === acc ? account.role : null });
  }
  if (rest === '/invites' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const role = String(body?.role ?? '');
    if (!ROLE_SET.has(role) || role === 'owner')
      return err(400, 'validation_failed', 'Invite someone as an admin, helper or viewer.');
    const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, 'validation_failed', 'That email does not look right.');
    const flows = cleanFlows(body?.flows);
    if (flows && (role === 'admin')) return err(400, 'validation_failed', 'Admins look after the whole business, not one flow.');
    const r = await supa('/rest/v1/rpc/fw_create_invite', {
      token,
      method: 'POST',
      body: { p_account: acc, p_role: role, p_email: email, p_flows: flows },
    });
    if (!r.ok || typeof r.data !== 'string') return denied(r, 'invite people');
    return ok(201, { token: r.data, url: `${new URL(request.url).origin}/join/${r.data}`, role, email, flows });
  }
  const inviteId = rest.match(/^\/invites\/([0-9a-f-]{36})$/);
  if (inviteId && method === 'DELETE') {
    const r = await supa('/rest/v1/rpc/fw_revoke_invite', { token, method: 'POST', body: { p_id: inviteId[1] } });
    return r.ok ? new Response(null, { status: 204 }) : denied(r, 'cancel invites');
  }
  const member = rest.match(/^\/members\/([0-9a-f-]{36})$/);
  if (member && method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const role = String(body?.role ?? '');
    if (!ROLE_SET.has(role)) return err(400, 'validation_failed', 'Choose owner, admin, helper or viewer.');
    const r = await supa('/rest/v1/rpc/fw_set_member', {
      token,
      method: 'POST',
      body: { p_account: acc, p_user: member[1], p_role: role, p_flows: cleanFlows(body?.flows) },
    });
    return r.ok ? ok(200, { user_id: member[1], role }) : denied(r, 'change that person’s role');
  }
  if (member && method === 'DELETE') {
    const r = await supa('/rest/v1/rpc/fw_remove_member', {
      token,
      method: 'POST',
      body: { p_account: acc, p_user: member[1] },
    });
    return r.ok ? new Response(null, { status: 204 }) : denied(r, 'remove that person');
  }
  return null;
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

  const me = await signedIn(request);
  if (me.error) return me.error;
  const { token, user } = me;
  const where = await accountOf(request, token);
  if (where.error) return where.error;
  const { accounts, account } = where;

  if (path === '/accounts' && method === 'GET') return ok(200, accounts);
  const handled = await accountRoutes(request, method, path, token, account);
  if (handled) return handled;

  if (path === '/session') {
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json(200, {
      data: {
        paired_at: user.last_sign_in_at ?? user.created_at,
        device_label: user.email,
        account: account ? { id: account.id, name: account.name, role: account.role, flows: account.flows } : null,
      },
      as_of: new Date().toISOString(),
      head_seq: null,
      next_cursor: null,
    });
  }

  // FW-C-085: the setup assistant. Nothing is stored or logged; a key-shaped question is refused unsent.
  // Before the business check: someone with no business yet is the person most likely to need it.
  if (path === '/assistant/setup' && method === 'POST') {
    const r = await answerSetupQuestion(await request.json().catch(() => ({})), { env: process.env });
    return json(r.status, r.body);
  }

  // Everything below is about one business. A new login has none yet: the screens offer to make one.
  if (!account) return err(404, 'no_account', 'Make a business first, or open an invite link.');

  // FW-C-092: the AI console on every page. It reads the mirror for this business and only proposes; a change is
  // made when the person confirms, through the same queued request the page's own control sends.
  if (path === '/assistant/console' && method === 'POST') {
    const store = mirrorStore(token, account.id);
    const read = async (p) => {
      const r = await resolveRead(p, new URLSearchParams(), store);
      return r.status === 200 ? r.body : null;
    };
    const r = await answerConsole(await request.json().catch(() => ({})), {
      env: process.env,
      role: account.role,
      flows: account.flows,
      read,
    });
    return json(r.status, r.body);
  }

  // FW-C-112: build requests. Something FlowWeb cannot do yet, written up (usually by Kevin) for the builder.
  // Straight to the database, not through the relay: nothing on the Mac changes until it is built.
  if (path === '/build-requests' && method === 'GET') {
    const r = await supa(
      `/rest/v1/fw_build_requests?select=id,title,what,done_when,status,pr_url,note,created_at,updated_at&account_id=eq.${account.id}&order=created_at.desc`,
      { token },
    );
    if (!r.ok) return err(500, 'internal', 'Could not read build requests.');
    return ok(200, r.data);
  }
  if (path === '/build-requests' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const title = text(body?.title);
    const what = text(body?.what);
    const done = text(body?.done_when);
    if (!title || title.length > 120) return err(400, 'validation_failed', 'Give the request a title (up to 120 characters).');
    if (!what || what.length > 4000) return err(400, 'validation_failed', 'Say what you want built (up to 4000 characters).');
    if (done.length > 1000) return err(400, 'validation_failed', '"Done when" is at most 1000 characters.');
    const r = await supa('/rest/v1/rpc/fw_build_request', {
      token,
      method: 'POST',
      body: { p_account: account.id, p_title: title, p_what: what, p_done: done },
    });
    if (!r.ok || typeof r.data !== 'string') return denied(r, 'ask for new features');
    return ok(201, { id: r.data, status: 'new' });
  }

  if (path === '/hosted/machines' && method === 'GET') {
    const r = await supa(
      `/rest/v1/fw_runners?select=id,label,created_at,last_seen_at,report,revoked_at&account_id=eq.${account.id}&order=created_at.desc`,
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
      body: { p_account: account.id, p_label: String(body?.label ?? 'machine') },
    });
    if (!r.ok) return denied(r, 'add machines');
    if (typeof r.data !== 'string' || !r.data.startsWith('fwr_'))
      return err(500, 'internal', 'The relay token was not created.');
    return json(201, { data: { token: r.data }, as_of: new Date().toISOString(), head_seq: null, next_cursor: null });
  }
  const revoke = path.match(/^\/hosted\/machines\/([0-9a-f-]{36})\/revoke$/);
  if (revoke && method === 'POST') {
    const r = await supa('/rest/v1/rpc/fw_revoke_runner', { token, method: 'POST', body: { p_id: revoke[1] } });
    if (!r.ok) return denied(r, 'remove machines');
    return new Response(null, { status: 204 });
  }

  // A draft change or a flow control (FW-C-062): queued here, applied on the Owner's machine by the relay.
  const asked =
    method === 'POST' || method === 'DELETE'
      ? requestOf(method, path, method === 'POST' ? await request.json().catch(() => ({})) : {})
      : null;
  if (asked?.error) return err(400, 'validation_failed', asked.error);
  if (asked) {
    const r = await supa('/rest/v1/rpc/fw_request', {
      token,
      method: 'POST',
      body: {
        p_account: account.id,
        p_kind: asked.kind,
        p_flow: asked.flow,
        p_draft_id: asked.draft_id,
        p_payload: asked.payload,
      },
    });
    if (!r.ok || typeof r.data !== 'string') return denied(r, 'make that change');
    return json(202, {
      data: { request_id: r.data, status: 'queued' },
      as_of: new Date().toISOString(),
      head_seq: null,
      next_cursor: null,
    });
  }
  const reqId = path.match(/^\/hosted\/requests\/([0-9a-f-]{36})$/);
  if (reqId && method === 'GET') {
    const r = await supa(
      `/rest/v1/fw_requests?select=id,kind,status,result,error,created_at,done_at&id=eq.${reqId[1]}`,
      { token },
    );
    if (!r.ok) return err(500, 'internal', 'Could not read that request.');
    if (!r.data?.[0]) return err(404, 'not_found', 'No such request.');
    return json(200, { data: r.data[0], as_of: new Date().toISOString(), head_seq: null, next_cursor: null });
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
    const r = await resolveRead(path, params, mirrorStore(token, account.id));
    return json(r.status, r.body);
  } catch (e) {
    return err(502, 'internal', String(e?.message ?? e));
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
