// Probe for FW-C-112 (an owner asks Kevin, the AI console, for something FlowWeb cannot do yet, and it is
// saved as a build request the builder picks up): `pnpm probe hosted/build-requests`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: hosted/supabase/migrations/0010_flowweb_build_requests.sql (the table and its functions),
// api/v1.mjs (GET and POST /v1/build-requests), hosted/server/console.mjs (Kevin may propose a build request)
// and packages/web/src/settings/BuildRequests.tsx (the list in Settings). Behind the API, the hosted
// migrations run in PGlite with the auth stand-in of probes/hosted/accounts.mjs, and a small PostgREST
// stand-in answers the function's fetch calls, so roles, grants and row-level security are the database's own.
//
// The surface this probe expects:
//   POST /v1/build-requests { title, what, done_when } -> 201 { data: { id, status: 'new' } } for an owner
//     or admin; 403 for a helper or viewer; 400 when title or what is missing or too long.
//   GET /v1/build-requests -> 200 { data: [ { id, title, what, done_when, status, pr_url, note, created_at,
//     updated_at } ] } for any member, only this business's requests, newest first.
//   public.fw_set_build_request(p_id uuid, p_status text, p_pr_url text, p_note text) moves a request along
//     (new, building, pr_open, done, declined); only the builder (service_role or the database owner) may.
//   console.mjs keepProposals keeps an owner's propose_change of POST /build-requests with kind
//     'build.request', and drops it for a helper or viewer; CONSOLE_PROMPT tells Kevin about it.
//   SettingsPage.tsx renders <BuildRequests />.
//
// Proves, in order:
//   1. An owner saves a build request; a helper and a viewer cannot; a bad one answers 400.
//   2. Every member lists the business's requests; another business's request never shows.
//   3. Only the builder moves a request along, and the list shows its status and pull request.
//   4. Kevin may propose a build request to an owner, and not to a helper or viewer.
//   5. Settings shows the requests.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'hosted/build-requests';
const MIG = join(root, 'hosted/supabase/migrations');

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
const PEOPLE = {
  'tok-owner': { id: uid(1), email: 'owner@example.com' },
  'tok-helper': { id: uid(2), email: 'helper@example.com' },
  'tok-viewer': { id: uid(3), email: 'viewer@example.com' },
  'tok-other': { id: uid(4), email: 'other@example.com' },
};

await probe(NAME, async () => {
  if (!readdirSync(MIG).some((f) => /^0010_.*build_requests\.sql$/.test(f)))
    missing('hosted/supabase/migrations has no 0010 build requests migration (row FW-C-112)');
  const src = readFileSync(join(root, 'api/v1.mjs'), 'utf8');
  if (!src.includes('/build-requests')) missing('api/v1.mjs has no /build-requests route (row FW-C-112)');

  // The API reads its Supabase settings when it loads.
  process.env.SUPABASE_URL = 'https://supa.example';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  const api = await import(`${pathToFileURL(join(root, 'api/v1.mjs')).href}?probe=${Date.now()}`);
  const consoleMod = await import(pathToFileURL(join(root, 'hosted/server/console.mjs')).href);

  const req = createRequire(join(root, 'package.json'));
  const { PGlite } = await import(pathToFileURL(req.resolve('@electric-sql/pglite')).href);
  const { pgcrypto } = await import(pathToFileURL(req.resolve('@electric-sql/pglite/contrib/pgcrypto')).href);
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
    await db.exec(token === 'service' ? 'set role service_role' : p ? 'set role authenticated' : 'set role anon');
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role');
    }
  };

  // The PostgREST stand-in: /auth/v1/user, /rest/v1/rpc/<fn> and table reads, run as the bearer.
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
        const order = /created_at\.desc/.test(url.searchParams.get('order') ?? '') ? ' order by created_at desc' : '';
        return reply(200, await as(token, `select ${cols.join(', ')} from public.${table[1]}${order}`));
      }
    } catch (e) {
      return reply(e?.code === '42501' ? 403 : 400, { code: e?.code ?? '', message: String(e?.message ?? e) });
    }
    return reply(404, { message: 'no such path' });
  };

  const call = async (method, p, { token, body } = {}) => {
    const h = { 'content-type': 'application/json' };
    if (token) h.authorization = `Bearer ${token}`;
    const res = await api[method](
      new Request(`https://flowweb.example/api/v1?__p=${p}`, {
        method,
        headers: h,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // One business with an owner, a helper and a viewer; another business someone else owns.
  const [{ fw_create_account: acc }] = await as('tok-owner', `select public.fw_create_account('House')`);
  for (const [tok, role] of [['tok-helper', 'helper'], ['tok-viewer', 'viewer']]) {
    const [{ fw_create_invite: inv }] = await as('tok-owner', 'select public.fw_create_invite($1, $2, $3, null)', [
      acc,
      role,
      PEOPLE[tok].email,
    ]);
    await as(tok, 'select public.fw_accept_invite($1)', [inv]);
  }
  const [{ fw_create_account: other }] = await as('tok-other', `select public.fw_create_account('Elsewhere')`);
  await as('tok-other', 'select public.fw_build_request($1, $2, $3, $4)', [other, 'Not yours', 'Someone else', '']);

  // 1. Saving a request.
  const ask = { title: 'Weekly CSV of new leads', what: 'Email me a CSV of the week’s new leads every Monday.', done_when: 'A CSV arrives Monday morning.' };
  let r = await call('POST', 'build-requests', { body: ask });
  check(r.status === 401, `saving without a sign-in should answer 401, got ${r.status}`);
  for (const tok of ['tok-helper', 'tok-viewer']) {
    r = await call('POST', 'build-requests', { token: tok, body: ask });
    check(r.status === 403, `${tok} saving a build request should answer 403, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  r = await call('POST', 'build-requests', { token: 'tok-owner', body: { title: '', what: 'x' } });
  check(r.status === 400, `a request with no title should answer 400, got ${r.status}`);
  r = await call('POST', 'build-requests', { token: 'tok-owner', body: { title: 'x', what: 'y'.repeat(4001) } });
  check(r.status === 400, `a request longer than 4000 characters should answer 400, got ${r.status}`);
  r = await call('POST', 'build-requests', { token: 'tok-owner', body: ask });
  check(
    r.status === 201 && r.body?.data?.id && r.body?.data?.status === 'new',
    `the owner should get 201 with an id and status new: ${JSON.stringify(r)}`,
  );
  const id = r.body.data.id;

  // 2. Listing.
  for (const tok of ['tok-owner', 'tok-helper', 'tok-viewer']) {
    r = await call('GET', 'build-requests', { token: tok });
    const list = r.body?.data;
    check(
      r.status === 200 && Array.isArray(list) && list.length === 1 && list[0].id === id && list[0].title === ask.title &&
        list[0].what === ask.what && list[0].done_when === ask.done_when && list[0].status === 'new',
      `${tok} should see exactly this business's request: ${JSON.stringify(r)}`,
    );
  }

  // 3. Only the builder moves it along.
  let refused = false;
  try {
    await as('tok-owner', 'select public.fw_set_build_request($1, $2, $3, $4)', [id, 'done', null, null]);
  } catch {
    refused = true;
  }
  check(refused, 'an owner must not be able to mark their own build request done');
  const pr = 'https://github.com/hellofrequencylab/flowweb/pull/1';
  await as('service', 'select public.fw_set_build_request($1, $2, $3, $4)', [id, 'pr_open', pr, 'Built, checks running']);
  r = await call('GET', 'build-requests', { token: 'tok-helper' });
  check(
    r.body?.data?.[0]?.status === 'pr_open' && r.body.data[0].pr_url === pr && r.body.data[0].note === 'Built, checks running',
    `the list should show the builder's status and pull request: ${JSON.stringify(r.body)}`,
  );
  refused = false;
  try {
    await as('service', 'select public.fw_set_build_request($1, $2, $3, $4)', [id, 'shipped', null, null]);
  } catch {
    refused = true;
  }
  check(refused, 'a status outside new, building, pr_open, done, declined must be refused');

  // 4. Kevin proposes a build request to an owner only.
  const { keepProposals, CONSOLE_PROMPT } = consoleMod;
  check(/\/build-requests/.test(CONSOLE_PROMPT), 'CONSOLE_PROMPT does not tell Kevin about /build-requests');
  const block = {
    type: 'tool_use',
    id: 'tu_1',
    name: 'propose_change',
    input: { summary: 'Ask for a weekly CSV of new leads.', method: 'POST', path: '/build-requests', body: ask },
  };
  const kept = keepProposals([block], { role: 'owner', flows: null });
  check(
    kept.length === 1 && kept[0].kind === 'build.request' && kept[0].path === '/build-requests',
    `an owner's build request proposal should be kept as build.request: ${JSON.stringify(kept)}`,
  );
  for (const role of ['helper', 'viewer'])
    check(keepProposals([block], { role, flows: null }).length === 0, `a ${role} must not get a build request proposal`);
  const empty = { ...block, input: { ...block.input, body: { title: '', what: '' } } };
  check(keepProposals([empty], { role: 'owner', flows: null }).length === 0, 'an empty build request must be dropped');

  // 5. Settings.
  let page = '';
  try {
    page = readFileSync(join(root, 'packages/web/src/settings/SettingsPage.tsx'), 'utf8');
    readFileSync(join(root, 'packages/web/src/settings/BuildRequests.tsx'), 'utf8');
  } catch {
    missing('packages/web/src/settings/BuildRequests.tsx does not exist (row FW-C-112)');
  }
  check(/<BuildRequests\b/.test(page), 'SettingsPage.tsx does not render <BuildRequests />');
});
