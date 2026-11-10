// Probe for FW-C-083 (people share a FlowWeb business with roles, and each business sees only its own
// data): `pnpm probe hosted/accounts`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: hosted/supabase/migrations/0001..0006 run in order inside PGlite (Postgres in WebAssembly, no
// server) under a small stand-in for Supabase's auth schema (auth.users, auth.jwt(), auth.uid() reading
// request.jwt.claims, the anon and authenticated roles), so row level security is checked for real;
// hosted/server/accounts.mjs (the role table the screens use); and api/v1.mjs (the hosted /v1) against a
// fetch stub standing in for Supabase.
//
// The surface this probe expects:
//   Migration 0006 adds fw_accounts, fw_members (role owner | admin | helper | viewer, flows text[] or null
//   for the whole business) and fw_invites, puts account_id on fw_mirror, fw_runners and fw_requests, and
//   moves existing data into one account owned by the fw_owners logins. Functions: fw_my_accounts(),
//   fw_create_account(name), fw_rename_account, fw_delete_account(account), fw_create_invite(account, role,
//   email, flows) -> 'fwi_...', fw_revoke_invite(id), fw_accept_invite(token) -> account,
//   fw_set_member(account, user, role, flows), fw_remove_member(account, user),
//   fw_create_runner_token(account, label), fw_request(account, kind, flow, draft_id, payload),
//   fw_can(account, action, flow), and the relay's fw_relay_ingest / fw_relay_take unchanged in shape.
//   hosted/server/accounts.mjs exports ROLES and can(role, action) for the actions
//   delete | members | machines | rename | control | drafts, agreeing with fw_can.
//   api/v1.mjs serves GET/POST /v1/accounts, GET /v1/accounts/{id}/members, POST /v1/accounts/{id}/invites
//   (answers the token and a /join/<token> link), PATCH and DELETE /v1/accounts/{id}/members/{user},
//   POST /v1/invites/{token}/accept; reads the mirror only for the account named by the x-fw-account
//   header (or the person's only account), refuses an account they are not in, and passes that account to
//   every machine and request call. A signed-in person with no business still gets /v1/session.
//
// Proves, in order:
//   1. Existing data lands in one account the old owner owns; the old relay token keeps working.
//   2. A stranger sees nothing, and can make a business of their own.
//   3. Invites: by email (the wrong email cannot use it), by link, for one flow; used or revoked ones fail.
//   4. Reads follow role and flow: a one-flow viewer sees only that flow's rows; only admins see machines.
//   5. Queued requests follow role and flow.
//   6. Machines and the relay stay inside their own business.
//   7. Owner rules: admins cannot touch owners, the last owner stays, anyone can leave, only owners delete.
//   8. hosted/server/accounts.mjs agrees with the database for every role and action.
//   9. The hosted /v1 account routes and account scoping.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'hosted/accounts';
const MIG = join(root, 'hosted/supabase/migrations');
const FLOW = 'neighborhood-activation';
const OTHER = 'local-saturation';
// A stand-in invite token, plain on purpose so the secret scan does not take it for a real one.
const INVITE = `fwi_${'0'.repeat(32)}`;

const STUB = `
  create schema if not exists auth;
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  grant usage on schema auth, extensions, public to anon, authenticated;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
  create function auth.uid() returns uuid language sql stable as
    $f$ select nullif(auth.jwt() ->> 'sub', '')::uuid $f$;
`;

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PEOPLE = {
  owner: { id: uid(1), email: 'owner@example.com' },
  admin: { id: uid(2), email: 'admin@example.com' },
  helper: { id: uid(3), email: 'helper@example.com' },
  viewer: { id: uid(4), email: 'viewer@example.com' },
  flowViewer: { id: uid(5), email: 'flowviewer@example.com' },
  flowHelper: { id: uid(6), email: 'flowhelper@example.com' },
  stranger: { id: uid(7), email: 'stranger@example.com' },
  wrong: { id: uid(8), email: 'wrong@example.com' },
};

await probe(NAME, async () => {
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  if (!files.some((f) => f.startsWith('0006_')))
    missing('hosted/supabase/migrations has no 0006 migration for accounts (row FW-C-083)');

  const req = createRequire(join(root, 'package.json'));
  let PGlite;
  let pgcrypto;
  try {
    ({ PGlite } = await import(pathToFileURL(req.resolve('@electric-sql/pglite')).href));
    ({ pgcrypto } = await import(pathToFileURL(req.resolve('@electric-sql/pglite/contrib/pgcrypto')).href));
  } catch {
    missing('@electric-sql/pglite is not installed (pnpm install)');
  }
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUB);
  for (const p of Object.values(PEOPLE))
    await db.query('insert into auth.users (id, email) values ($1, $2)', [p.id, p.email]);

  // The world before 0006: one owner, one machine, a snapshot and a queued request.
  for (const f of files.filter((x) => x < '0006')) await db.exec(readFileSync(join(MIG, f), 'utf8'));
  await db.exec(`insert into public.fw_owners (email) values ('owner@example.com');
    insert into public.fw_runners (label, token_hash)
      values ('old mac', encode(extensions.digest('fwr_old', 'sha256'), 'hex'));
    insert into public.fw_requests (kind, flow, draft_id, created_by)
      values ('draft.edit', '${FLOW}', 'd_1', 'owner@example.com');`);
  const snapshot = {
    '/status': { data: { daemon: 'up' } },
    '/supervisor': { data: { flows: [FLOW, OTHER] } },
    [`/supervisor/flows/${FLOW}/drafts`]: { data: ['d_1'] },
    [`/supervisor/flows/${OTHER}/drafts`]: { data: ['d_2'] },
  };
  await db.query('select public.fw_relay_ingest($1, $2, $3)', ['fwr_old', snapshot, {}]);

  for (const f of files.filter((x) => x >= '0006')) await db.exec(readFileSync(join(MIG, f), 'utf8'));

  // Acting as someone: the same switch PostgREST makes for a request with that person's token.
  const as = async (who, sql, params = []) => {
    const p = typeof who === 'string' ? PEOPLE[who] : who;
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
  const refused = async (who, sql, params = []) => {
    try {
      await as(who, sql, params);
      return false;
    } catch {
      return true;
    }
  };
  const one = async (who, sql, params) => Object.values((await as(who, sql, params))[0] ?? {})[0];

  // 1. Existing data moved into the owner's account.
  const mine = await as('owner', 'select * from public.fw_my_accounts()');
  check(mine.length === 1 && mine[0].role === 'owner', `the old owner should own one account, got ${JSON.stringify(mine)}`);
  const ACC = mine[0].id;
  const keysOf = async (who) => (await as(who, 'select key from public.fw_mirror order by key')).map((r) => r.key);
  check((await keysOf('owner')).length === 4, 'the old owner should still read all four mirror rows');
  await db.query('select public.fw_relay_ingest($1, $2, $3)', ['fwr_old', snapshot, {}]);
  check((await keysOf('owner')).length === 4, 'the old relay token should keep filling the same account');
  check((await as('owner', 'select id from public.fw_requests')).length === 1, 'the old request should belong to the account');

  // 2. A stranger sees nothing and can start their own business.
  check((await keysOf('stranger')).length === 0, 'a stranger can read the mirror');
  check((await as('stranger', 'select id from public.fw_runners')).length === 0, 'a stranger can read machines');
  check((await as('stranger', 'select user_id from public.fw_members')).length === 0, 'a stranger can read members');
  check((await as('stranger', 'select id from public.fw_requests')).length === 0, 'a stranger can read requests');
  check(
    await refused('stranger', 'select public.fw_create_invite($1, $2, null, null)', [ACC, 'admin']),
    'a stranger made an invite to someone else’s business',
  );
  check(await refused(null, `select public.fw_create_account('Anon Co')`), 'a signed-out caller made a business');
  const XACC = await one('stranger', `select public.fw_create_account('Stranger Studio')`);
  check(
    (await as('stranger', 'select role from public.fw_my_accounts()')).map((r) => r.role).join() === 'owner',
    'a new business should list its maker as owner',
  );

  // 3. Invites.
  const invite = (role, email, flows = null) =>
    one('owner', 'select public.fw_create_invite($1, $2, $3, $4)', [ACC, role, email, flows]);
  const accept = (who, tok) => as(who, 'select public.fw_accept_invite($1)', [tok]);
  const tAdmin = await invite('admin', 'admin@example.com');
  check(/^fwi_[0-9a-f]{32,}$/.test(String(tAdmin)), `an invite token should start fwi_, got ${tAdmin}`);
  check(await refused('wrong', 'select public.fw_accept_invite($1)', [tAdmin]), 'the wrong email used an email invite');
  await accept('admin', tAdmin);
  check(await refused('helper', 'select public.fw_accept_invite($1)', [tAdmin]), 'a used invite worked twice');
  await accept('helper', await invite('helper', null));
  await accept('viewer', await invite('viewer', 'Viewer@Example.com'));
  await accept('flowViewer', await invite('viewer', null, [FLOW]));
  await accept('flowHelper', await invite('helper', null, [FLOW]));
  check(
    await refused('owner', 'select public.fw_create_invite($1, $2, null, $3)', [ACC, 'admin', [FLOW]]),
    'an admin invite limited to one flow was allowed',
  );
  check(
    await refused('owner', 'select public.fw_create_invite($1, $2, null, null)', [ACC, 'owner']),
    'an invite straight to owner was allowed',
  );
  const tGone = await invite('viewer', null);
  const gone = (await as('owner', 'select id from public.fw_invites where accepted_at is null and revoked_at is null'))
    .map((r) => r.id)
    .pop();
  await as('owner', 'select public.fw_revoke_invite($1)', [gone]);
  check(await refused('wrong', 'select public.fw_accept_invite($1)', [tGone]), 'a revoked invite worked');
  const roles = Object.fromEntries(
    (await as('owner', 'select email, role from public.fw_members where account_id = $1', [ACC])).map((r) => [
      r.email,
      r.role,
    ]),
  );
  check(
    roles['admin@example.com'] === 'admin' &&
      roles['helper@example.com'] === 'helper' &&
      roles['viewer@example.com'] === 'viewer' &&
      roles['flowviewer@example.com'] === 'viewer',
    `members after invites: ${JSON.stringify(roles)}`,
  );

  // 4. Reads follow role and flow.
  check((await keysOf('viewer')).length === 4, 'a whole-business viewer should read every mirror row');
  const fv = await keysOf('flowViewer');
  check(
    fv.length === 1 && fv[0] === `/supervisor/flows/${FLOW}/drafts`,
    `a one-flow viewer should read only that flow, got ${JSON.stringify(fv)}`,
  );
  check((await as('viewer', 'select id from public.fw_runners')).length === 0, 'a viewer can read machines');
  check((await as('admin', 'select id from public.fw_runners')).length === 1, 'an admin cannot read machines');
  check((await as('helper', 'select id from public.fw_invites')).length === 0, 'a helper can read invites');
  check((await as('admin', 'select id from public.fw_invites')).length > 0, 'an admin cannot read invites');

  // 5. Requests follow role and flow.
  const ask = (who, kind, flow) =>
    refused(who, `select public.fw_request($1, $2, $3, 'd_1', '{}'::jsonb)`, [ACC, kind, flow]).then((r) => !r);
  const grid = [
    ['owner', 'flow.run', FLOW, true],
    ['owner', 'supervisor.pause', 'all', true],
    ['admin', 'flow.run', FLOW, true],
    ['admin', 'draft.edit', OTHER, true],
    ['helper', 'draft.edit', FLOW, true],
    ['helper', 'draft.approve', FLOW, true],
    ['helper', 'flow.run', FLOW, false],
    ['helper', 'hunt.run', FLOW, false],
    ['viewer', 'draft.edit', FLOW, false],
    ['flowViewer', 'draft.edit', FLOW, false],
    ['flowHelper', 'draft.edit', FLOW, true],
    ['flowHelper', 'draft.edit', OTHER, false],
    ['flowHelper', 'supervisor.pause', 'all', false],
    ['stranger', 'draft.edit', FLOW, false],
  ];
  for (const [who, kind, flow, ok] of grid)
    check((await ask(who, kind, flow)) === ok, `${who} asking ${kind} on ${flow} should be ${ok ? 'allowed' : 'refused'}`);
  const hv = await as('flowHelper', 'select flow from public.fw_requests');
  check(hv.every((r) => r.flow === FLOW), 'a one-flow helper can read requests about other flows');

  // 6. Machines and the relay stay inside their own business.
  check(
    await refused('helper', `select public.fw_create_runner_token($1, 'x')`, [ACC]),
    'a helper made a machine token',
  );
  const xTok = await one('stranger', `select public.fw_create_runner_token($1, 'stranger mac')`, [XACC]);
  check(String(xTok).startsWith('fwr_'), 'an owner could not make a machine token for their own business');
  check(
    await refused('stranger', `select public.fw_create_runner_token($1, 'sneak')`, [ACC]),
    'a stranger made a machine token for someone else’s business',
  );
  await db.query('select public.fw_relay_ingest($1, $2, $3)', [xTok, { '/status': { data: { daemon: 'x' } } }, {}]);
  check((await keysOf('owner')).length === 4, 'another business’s relay snapshot removed or replaced this one’s rows');
  check((await keysOf('stranger')).join() === '/status', 'a business should read its own relay snapshot');
  const taken = (await db.query('select * from public.fw_relay_take($1, 50)', [xTok])).rows;
  check(taken.length === 0, 'a relay took requests from another business');
  const ownTaken = (await db.query('select * from public.fw_relay_take($1, 50)', ['fwr_old'])).rows;
  check(ownTaken.length > 0 && ownTaken.every((r) => r.account_id === ACC), 'the old relay should take its own requests');

  // 7. Owner rules.
  const setRole = (who, user, role, flows = null) =>
    refused(who, 'select public.fw_set_member($1, $2, $3, $4)', [ACC, PEOPLE[user].id, role, flows]).then((r) => !r);
  check(!(await setRole('admin', 'owner', 'viewer')), 'an admin demoted the owner');
  check(!(await setRole('admin', 'helper', 'owner')), 'an admin made an owner');
  check(await setRole('admin', 'helper', 'viewer'), 'an admin could not change a helper to viewer');
  check(!(await setRole('helper', 'viewer', 'admin')), 'a helper changed a role');
  check(!(await setRole('owner', 'owner', 'admin')), 'the last owner stepped down');
  check(
    await refused('owner', 'select public.fw_remove_member($1, $2)', [ACC, PEOPLE.owner.id]),
    'the last owner left the business',
  );
  check(
    await refused('viewer', 'select public.fw_remove_member($1, $2)', [ACC, PEOPLE.helper.id]),
    'a viewer removed someone',
  );
  check(
    !(await refused('helper', 'select public.fw_remove_member($1, $2)', [ACC, PEOPLE.helper.id])),
    'a member could not leave',
  );
  check(await setRole('owner', 'admin', 'owner'), 'an owner could not make another owner');
  check(await setRole('owner', 'owner', 'admin'), 'an owner could not step down once another owner exists');
  check(await refused('owner', 'select public.fw_delete_account($1)', [ACC]), 'an admin deleted the business');
  check(
    !(await refused('stranger', 'select public.fw_delete_account($1)', [XACC])),
    'an owner could not delete their business',
  );
  check((await keysOf('stranger')).length === 0, 'deleting a business left its mirror rows behind');

  // 8. The role table the screens use agrees with the database.
  const mod = await import(pathToFileURL(join(root, 'hosted/server/accounts.mjs')).href).catch(() => null);
  if (!mod || typeof mod.can !== 'function') missing('hosted/server/accounts.mjs does not export can (row FW-C-083)');
  check(
    JSON.stringify(mod.ROLES) === JSON.stringify(['owner', 'admin', 'helper', 'viewer']),
    `ROLES should be owner, admin, helper, viewer; got ${JSON.stringify(mod.ROLES)}`,
  );
  const ACTIONS = ['delete', 'members', 'machines', 'rename', 'control', 'drafts'];
  const holder = { owner: 'admin', admin: 'owner', viewer: 'viewer', helper: null };
  await as('admin', 'select public.fw_set_member($1, $2, $3, null)', [ACC, PEOPLE.flowHelper.id, 'helper']);
  holder.helper = 'flowHelper';
  for (const [role, who] of Object.entries(holder))
    for (const action of ACTIONS) {
      const sql = (await one(who, 'select public.fw_can($1, $2, null)', [ACC, action])) === true;
      check(mod.can(role, action) === sql, `can('${role}', '${action}') is ${mod.can(role, action)}, the database says ${sql}`);
    }

  // 9. The hosted /v1.
  await apiChecks(ACC);
});

async function apiChecks(ACC) {
  const ACC2 = uid(99);
  process.env.SUPABASE_URL = 'https://supa.example';
  process.env.SUPABASE_ANON_KEY = 'anon';
  let accounts = [{ id: ACC, name: 'My FlowWeb', role: 'owner', flows: null }];
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), path: url.pathname, search: decodeURIComponent(url.search), body });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/auth/v1/user') return reply(200, { id: uid(1), email: 'owner@example.com' });
    if (url.pathname === '/rest/v1/rpc/fw_my_accounts') return reply(200, accounts);
    if (url.pathname === '/rest/v1/rpc/fw_create_account') return reply(200, ACC2);
    if (url.pathname === '/rest/v1/rpc/fw_create_invite') return reply(200, INVITE);
    if (url.pathname === '/rest/v1/rpc/fw_accept_invite') return reply(200, ACC);
    if (url.pathname === '/rest/v1/rpc/fw_request') return reply(200, uid(50));
    if (url.pathname === '/rest/v1/rpc/fw_create_runner_token') return reply(200, `fwr_${'a'.repeat(64)}`);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return reply(200, null);
    return reply(200, []);
  };
  const api = await import(`${pathToFileURL(join(root, 'api/v1.mjs')).href}?probe=${Date.now()}`);
  const call = async (method, p, { body, account } = {}) => {
    calls.length = 0;
    const handler = api[method];
    check(typeof handler === 'function', `api/v1.mjs does not export ${method}`);
    const headers = { authorization: 'Bearer user-token', 'content-type': 'application/json' };
    if (account) headers['x-fw-account'] = account;
    const res = await handler(
      new Request(`https://flowweb.example/api/v1?__p=${p}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const rpc = (name) => calls.find((c) => c.path === `/rest/v1/rpc/${name}`);

  let r = await call('GET', 'accounts');
  check(r.status === 200 && r.body?.data?.[0]?.id === ACC, `GET /v1/accounts should list the person’s accounts: ${JSON.stringify(r)}`);

  r = await call('GET', 'status', { account: ACC });
  const mirrorCalls = calls.filter((c) => c.path === '/rest/v1/fw_mirror');
  check(
    mirrorCalls.length > 0 && mirrorCalls.every((c) => c.search.includes(`account_id=eq.${ACC}`)),
    `mirror reads should be filtered to the chosen account: ${JSON.stringify(mirrorCalls.map((c) => c.search))}`,
  );
  r = await call('GET', 'status');
  check(
    calls.filter((c) => c.path === '/rest/v1/fw_mirror').every((c) => c.search.includes(`account_id=eq.${ACC}`)),
    'with one account and no header, mirror reads should use that account',
  );
  r = await call('GET', 'status', { account: ACC2 });
  check(r.status === 403, `an account the person is not in should answer 403, got ${r.status}`);

  r = await call('POST', 'accounts', { body: { name: 'Corner Cafe' } });
  check(r.status === 201 && rpc('fw_create_account')?.body?.p_name === 'Corner Cafe', `POST /v1/accounts: ${JSON.stringify(r)}`);

  r = await call('POST', `accounts/${ACC}/invites`, {
    body: { role: 'helper', email: 'friend@example.com', flows: [FLOW] },
  });
  const inv = rpc('fw_create_invite')?.body;
  check(
    r.status === 201 &&
      inv?.p_account === ACC &&
      inv?.p_role === 'helper' &&
      inv?.p_email === 'friend@example.com' &&
      JSON.stringify(inv?.p_flows) === JSON.stringify([FLOW]),
    `POST /v1/accounts/{id}/invites should make the invite: ${JSON.stringify({ r, inv })}`,
  );
  check(
    String(r.body?.data?.url ?? '').endsWith(`/join/${INVITE}`),
    `the invite should answer a /join/<token> link: ${JSON.stringify(r.body)}`,
  );

  r = await call('POST', `invites/${INVITE}/accept`);
  check(
    r.status === 200 && rpc('fw_accept_invite')?.body?.p_token === INVITE && r.body?.data?.account_id === ACC,
    `POST /v1/invites/{token}/accept: ${JSON.stringify(r)}`,
  );

  r = await call('GET', `accounts/${ACC}/members`);
  check(
    r.status === 200 && calls.some((c) => c.path === '/rest/v1/fw_members' && c.search.includes(`account_id=eq.${ACC}`)),
    `GET /v1/accounts/{id}/members should read that account’s members: ${JSON.stringify(r)}`,
  );
  r = await call('PATCH', `accounts/${ACC}/members/${uid(3)}`, { body: { role: 'viewer', flows: null } });
  const set = rpc('fw_set_member')?.body;
  check(
    r.status < 300 && set?.p_account === ACC && set?.p_user === uid(3) && set?.p_role === 'viewer',
    `PATCH a member: ${JSON.stringify({ r, set })}`,
  );
  r = await call('DELETE', `accounts/${ACC}/members/${uid(3)}`);
  check(r.status < 300 && rpc('fw_remove_member')?.body?.p_user === uid(3), `DELETE a member: ${JSON.stringify(r)}`);

  r = await call('POST', `supervisor/flows/${FLOW}/run`, { body: {}, account: ACC });
  check(r.status === 202 && rpc('fw_request')?.body?.p_account === ACC, `a queued request should carry the account: ${JSON.stringify(r)}`);
  r = await call('POST', 'hosted/machines', { body: { label: 'mac' }, account: ACC });
  check(
    r.status === 201 && rpc('fw_create_runner_token')?.body?.p_account === ACC,
    `a machine token should belong to the account: ${JSON.stringify(r)}`,
  );

  accounts = [];
  r = await call('GET', 'session');
  check(r.status === 200, `a signed-in person with no business should still get /v1/session, got ${r.status}`);
}
