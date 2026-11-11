// Probe for FW-C-111 (an owner links their FlowWeb business to a Frequency Space on flowweb.app, and
// Frequency's signed funnel events reach that business): `pnpm probe hosted/plugin-routes`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: api/plugin.mjs (the hosted /v1/plugin, a Vercel Function exporting GET, POST and PATCH) and
// vercel.json (the rewrite that sends /v1/plugin/* there). Behind them, hosted/supabase/migrations run in
// PGlite with the same auth stand-in as probes/hosted/accounts.mjs, and a small PostgREST stand-in answers
// the function's fetch calls: /auth/v1/user, /rest/v1/rpc/<fn> (named arguments, run as anon or as the
// signed-in person) and table reads. So roles, grants and signature checks are the database's real ones.
// frequency-link.mjs signs as Frequency would.
//
// The surface this probe expects:
//   vercel.json rewrites /v1/plugin/:path* to /api/plugin?__p=:path* ahead of the /v1 rewrite.
//   GET /v1/plugin/links -> the signed-in person's links (never a secret)
//   POST /v1/plugin/links { account, space_id, house } -> 201 { data: { id, space_id, secret } }
//   POST /v1/plugin/links/{id}/rotate -> 200 { data: { secret } }; PATCH /v1/plugin/links/{id} { status }
//   POST /v1/plugin/links/{id}/events with x-flowweb-link, x-flowweb-timestamp, x-flowweb-signature ->
//     202 { data: { id } }; refusals carry error.reason: unsigned or unknown_link or stale or
//     bad_signature (401), paused (403), bad_event (400)
//   Without a sign-in the link routes answer 401; a helper gets 403 making a link.
//
// Proves, in order:
//   1. The rewrite sends /v1/plugin/* to api/plugin.mjs.
//   2. An owner links their business on the site and gets the secret once; a helper cannot; no sign-in, no link.
//   3. Listing shows the link without its secret.
//   4. A correctly signed event from Frequency is stored and the business's machine can take it.
//   5. Unsigned, wrong-link, stale, tampered, malformed and paused events are refused with their reason.
//   6. Rotating through the site retires the old secret.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'hosted/plugin-routes';
const MIG = join(root, 'hosted/supabase/migrations');
const API = join(root, 'api/plugin.mjs');
const SPACE = 'space_house';

const STUB = `
  create schema if not exists auth;
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
  grant usage on schema auth, extensions, public to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
  create function auth.uid() returns uuid language sql stable as
    $f$ select nullif(auth.jwt() ->> 'sub', '')::uuid $f$;
`;

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Bearer tokens the stand-in knows, each standing for one person.
const PEOPLE = {
  'tok-owner': { id: uid(1), email: 'owner@example.com' },
  'tok-helper': { id: uid(2), email: 'helper@example.com' },
};

await probe(NAME, async () => {
  let vercel;
  try {
    vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  } catch {
    missing('vercel.json is not readable');
  }
  const rewrites = vercel.rewrites ?? [];
  const pi = rewrites.findIndex((r) => r.source === '/v1/plugin/:path*' && r.destination === '/api/plugin?__p=:path*');
  const vi = rewrites.findIndex((r) => r.source === '/v1/:path*');
  if (pi < 0) missing('vercel.json has no /v1/plugin/:path* rewrite to /api/plugin (row FW-C-111)');
  check(vi < 0 || pi < vi, 'the /v1/plugin rewrite must come before the /v1 rewrite');

  let api;
  try {
    api = await import(`${pathToFileURL(API).href}?probe=${Date.now()}`);
  } catch {
    missing('api/plugin.mjs does not exist (row FW-C-111)');
  }
  for (const m of ['GET', 'POST', 'PATCH']) check(typeof api[m] === 'function', `api/plugin.mjs does not export ${m}`);

  const req = createRequire(join(root, 'package.json'));
  const { PGlite } = await import(pathToFileURL(req.resolve('@electric-sql/pglite')).href);
  const { pgcrypto } = await import(pathToFileURL(req.resolve('@electric-sql/pglite/contrib/pgcrypto')).href);
  const { sign } = await import(pathToFileURL(join(root, 'hosted/server/frequency-link.mjs')).href);

  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUB);
  for (const p of Object.values(PEOPLE))
    await db.query('insert into auth.users (id, email) values ($1, $2)', [p.id, p.email]);
  for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort())
    await db.exec(readFileSync(join(MIG, f), 'utf8'));

  const as = async (token, sql, params = []) => {
    const p = PEOPLE[token];
    await db.exec('reset role');
    const claims = p ? JSON.stringify({ sub: p.id, email: p.email, role: 'authenticated' }) : '';
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    await db.exec(p ? 'set role authenticated' : 'set role anon');
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role');
    }
  };

  // The PostgREST stand-in.
  process.env.SUPABASE_URL = 'https://supa.example';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  const reply = (status, data) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const token = String((init.headers ?? {}).authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/auth/v1/user')
      return PEOPLE[token] ? reply(200, PEOPLE[token]) : reply(401, { message: 'bad token' });
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    try {
      if (rpc) {
        const args = init.body ? JSON.parse(init.body) : {};
        const names = Object.keys(args);
        const call = `public.${rpc[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
        const rows = await as(token, `select * from ${call}`, names.map((n) => args[n]));
        const cols = rows[0] ? Object.keys(rows[0]) : [];
        return reply(200, cols.length === 1 && cols[0] === rpc[1] ? rows[0][cols[0]] : rows);
      }
      const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
      if (table) {
        const cols = (url.searchParams.get('select') ?? '*').split(',').filter((c) => /^[a-z_*]+$/.test(c));
        return reply(200, await as(token, `select ${cols.join(', ')} from public.${table[1]}`));
      }
    } catch (e) {
      return reply(400, { code: e?.code ?? '', message: String(e?.message ?? e) });
    }
    return reply(404, { message: 'no such path' });
  };

  const call = async (method, p, { token, body, raw, headers = {} } = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    const res = await api[method](
      new Request(`https://flowweb.example/api/plugin?__p=${p}`, {
        method,
        headers: h,
        ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // A business with an owner, a helper and a machine.
  const [{ fw_create_account: acc }] = await as('tok-owner', `select public.fw_create_account('House')`);
  const [{ fw_create_invite: invite }] = await as('tok-owner', `select public.fw_create_invite($1, 'helper', $2, null)`, [
    acc,
    PEOPLE['tok-helper'].email,
  ]);
  await as('tok-helper', 'select public.fw_accept_invite($1)', [invite]);
  const [{ fw_create_runner_token: runner }] = await as('tok-owner', `select public.fw_create_runner_token($1, 'mac')`, [acc]);

  // 2. Linking.
  let r = await call('POST', 'links', { body: { account: acc, space_id: SPACE, house: true } });
  check(r.status === 401, `linking without a sign-in should answer 401, got ${r.status}`);
  r = await call('POST', 'links', { token: 'tok-helper', body: { account: acc, space_id: SPACE, house: true } });
  check(r.status === 403, `a helper linking should answer 403, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', 'links', { token: 'tok-owner', body: { account: acc, space_id: 'bad space!' } });
  check(r.status === 400, `a malformed space_id should answer 400, got ${r.status}`);
  r = await call('POST', 'links', { token: 'tok-owner', body: { account: acc, space_id: SPACE, house: true } });
  check(
    r.status === 201 && r.body?.data?.id && /^fwl_[0-9a-f]{64}$/.test(r.body?.data?.secret ?? ''),
    `the owner should get 201 with an id and an fwl_ secret: ${JSON.stringify(r)}`,
  );
  const link = r.body.data.id;
  let secret = r.body.data.secret;
  r = await call('POST', 'links', { token: 'tok-owner', body: { account: acc, space_id: 'space_two' } });
  check(r.status === 409, `linking the same business twice should answer 409, got ${r.status}`);

  // 3. Listing.
  r = await call('GET', 'links', { token: 'tok-helper' });
  check(
    r.status === 200 && r.body?.data?.length === 1 && r.body.data[0].space_id === SPACE && !('secret' in r.body.data[0]),
    `a member should see the link without its secret: ${JSON.stringify(r)}`,
  );

  // 4. A signed event.
  const send = (body, { ts = Math.floor(Date.now() / 1000), key = secret, linkHeader = link, path = link } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return call('POST', `links/${path}/events`, {
      raw,
      headers: {
        'x-flowweb-link': linkHeader,
        'x-flowweb-timestamp': String(ts),
        'x-flowweb-signature': sign(key, String(ts), raw),
      },
    });
  };
  const event = (extra = {}) => ({ type: 'host.started', at: new Date().toISOString(), space_id: SPACE, niche: 'yoga', ...extra });
  r = await send(event());
  check(r.status === 202 && r.body?.data?.id, `a signed event should answer 202 with an id: ${JSON.stringify(r)}`);
  const taken = await as(null, 'select * from public.fw_relay_take_events($1, 50)', [runner]);
  check(taken.length === 1 && taken[0].type === 'host.started', `the machine should take the event: ${JSON.stringify(taken)}`);

  // 5. Refusals.
  const reason = (x) => x.body?.error?.reason;
  r = await call('POST', `links/${link}/events`, { raw: JSON.stringify(event()) });
  check(r.status === 401 && reason(r) === 'unsigned', `unsigned: ${JSON.stringify(r)}`);
  r = await send(event(), { linkHeader: uid(77) });
  check(r.status === 401 && reason(r) === 'unknown_link', `link header for another link: ${JSON.stringify(r)}`);
  r = await send(event(), { path: uid(77), linkHeader: uid(77) });
  check(r.status === 401 && reason(r) === 'unknown_link', `unknown link: ${JSON.stringify(r)}`);
  r = await send(event(), { ts: Math.floor(Date.now() / 1000) - 400 });
  check(r.status === 401 && reason(r) === 'stale', `stale: ${JSON.stringify(r)}`);
  r = await send(event(), { key: `fwl_${'0'.repeat(64)}` });
  check(r.status === 401 && reason(r) === 'bad_signature', `wrong secret: ${JSON.stringify(r)}`);
  r = await send(event({ type: 'member.deleted' }));
  check(r.status === 400 && reason(r) === 'bad_event', `unknown type: ${JSON.stringify(r)}`);
  r = await send('not json');
  check(r.status === 400 && reason(r) === 'bad_event', `not json: ${JSON.stringify(r)}`);
  r = await send(event({ space_id: 'space_other' }));
  check(r.status === 400 && reason(r) === 'bad_event', `wrong Space: ${JSON.stringify(r)}`);

  r = await call('PATCH', `links/${link}`, { token: 'tok-helper', body: { status: 'paused' } });
  check(r.status === 403, `a helper pausing should answer 403, got ${r.status}`);
  r = await call('PATCH', `links/${link}`, { token: 'tok-owner', body: { status: 'paused' } });
  check(r.status === 200, `the owner pausing should answer 200: ${JSON.stringify(r)}`);
  r = await send(event({ niche: 'paused' }));
  check(r.status === 403 && reason(r) === 'paused', `paused: ${JSON.stringify(r)}`);
  r = await call('PATCH', `links/${link}`, { token: 'tok-owner', body: { status: 'active' } });
  check(r.status === 200, 'the owner could not turn the link back on');

  // 6. Rotation.
  r = await call('POST', `links/${link}/rotate`, { token: 'tok-owner' });
  const fresh = r.body?.data?.secret;
  check(r.status === 200 && /^fwl_[0-9a-f]{64}$/.test(fresh ?? '') && fresh !== secret, `rotate: ${JSON.stringify(r)}`);
  r = await send(event({ niche: 'old' }));
  check(r.status === 401 && reason(r) === 'bad_signature', `the old secret still worked after rotating: ${JSON.stringify(r)}`);
  secret = fresh;
  r = await send(event({ niche: 'new' }));
  check(r.status === 202, `the new secret did not work after rotating: ${JSON.stringify(r)}`);
});
