// Probe for FW-C-162 (the relay sends only what changed, so a minute with no change costs a few bytes
// instead of the whole mirror): `pnpm probe hosted/relay-delta`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: hosted/supabase/migrations/0001..0015 run in order inside PGlite (Postgres in WebAssembly, no
// server) under a small stand-in for Supabase's auth schema; hosted/server/mirror.mjs (changedEntries,
// freshEnvelope); hosted/relay/fw-relay.mjs; and api/v1.mjs against a fetch stub standing in for Supabase.
//
// The surface this probe expects:
//   Migration 0015 adds fw_relay_ingest_delta(p_token, p_keys text[], p_entries jsonb, p_report jsonb):
//   p_keys is every key the machine holds, p_entries only the envelopes that changed. A row whose key is
//   not in p_keys is deleted; an envelope in p_entries is stored; a row in p_keys with no envelope keeps
//   its envelope and has synced_at moved forward; the answer's `missing` lists keys in p_keys the table
//   does not hold. fw_relay_ingest keeps working unchanged.
//   hosted/server/mirror.mjs exports changedEntries(entries, sent) -> { changed, prints }, which ignores
//   as_of and head_seq, and freshEnvelope(envelope, syncedAt), which answers the envelope with the later
//   of its as_of and syncedAt.
//   hosted/relay/fw-relay.mjs calls fw_relay_ingest_delta and falls back to fw_relay_ingest when the
//   database does not have it. api/v1.mjs reads synced_at with each mirror row and serves that freshness.
//
// Proves, in order:
//   1. A first delta push stores every envelope and reports nothing missing.
//   2. A second push with one changed envelope rewrites only that row; the others keep their envelope and
//      get a newer synced_at.
//   3. A key left out of p_keys is deleted; a key in p_keys that the table lost comes back as `missing`.
//   4. An envelope whose key is not in p_keys is not stored; a wrong token is refused.
//   5. Another business's rows are untouched, and the old whole-snapshot call still works.
//   6. changedEntries sends only changed data; freshEnvelope serves the later time.
//   7. The relay uses the delta call with a fallback, and the hosted /v1 serves a confirmed row as fresh.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'hosted/relay-delta';
const MIG = join(root, 'hosted/supabase/migrations');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

const env = (data, as_of = '2026-11-18T10:00:00.000Z') => ({ data, as_of, head_seq: 7, next_cursor: null });

await probe(NAME, async () => {
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  if (!files.some((f) => f.startsWith('0015_')))
    missing('hosted/supabase/migrations has no 0015 migration for the relay delta (row FW-C-162)');
  const mirror = await import(pathToFileURL(join(root, 'hosted/server/mirror.mjs')).href);
  if (typeof mirror.changedEntries !== 'function' || typeof mirror.freshEnvelope !== 'function')
    missing('hosted/server/mirror.mjs does not export changedEntries and freshEnvelope (row FW-C-162)');

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
  await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [
    uid(1),
    'owner@example.com',
    uid(2),
    'other@example.com',
  ]);
  for (const f of files) await db.exec(readFileSync(join(MIG, f), 'utf8'));

  // Two businesses, one machine each. Tokens are plain stand-ins, not real ones.
  const account = async (who, name, token) => {
    const claims = JSON.stringify({ sub: who, role: 'authenticated' });
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    const id = Object.values((await db.query('select public.fw_create_account($1)', [name])).rows[0])[0];
    await db.query(
      `insert into public.fw_runners (account_id, label, token_hash)
       values ($1, 'mac', encode(extensions.digest($2, 'sha256'), 'hex'))`,
      [id, token],
    );
    return id;
  };
  const ACC = await account(uid(1), 'Mine', 'fwr_mine');
  const OTHER = await account(uid(2), 'Theirs', 'fwr_theirs');
  const delta = async (token, keys, entries) =>
    Object.values(
      (await db.query('select public.fw_relay_ingest_delta($1, $2, $3, $4)', [token, keys, entries, {}])).rows[0],
    )[0];
  const rows = async (acc) =>
    new Map(
      (await db.query('select key, envelope, synced_at from public.fw_mirror where account_id = $1', [acc])).rows.map(
        (r) => [r.key, r],
      ),
    );
  // synced_at is now(), which stands still inside one statement only: age the rows so a touch shows.
  const age = () => db.exec(`update public.fw_mirror set synced_at = synced_at - interval '1 hour'`);

  await delta('fwr_theirs', ['/status'], { '/status': env({ whose: 'theirs' }) });

  // 1. First push.
  const all = { '/status': env({ n: 1 }), '/runs': env([{ id: 'r1' }]), '/policy': env({ p: 1 }) };
  let r = await delta('fwr_mine', Object.keys(all), all);
  check(r.stored === 3, `a first push should store 3 envelopes, stored ${r.stored}`);
  check(Array.isArray(r.missing) && r.missing.length === 0, `a first push should miss nothing: ${JSON.stringify(r.missing)}`);
  check((await rows(ACC)).size === 3, 'the first push should leave three rows');

  // 2. One changed envelope.
  await age();
  const before = await rows(ACC);
  r = await delta('fwr_mine', Object.keys(all), { '/status': env({ n: 2 }, '2026-11-18T10:01:00.000Z') });
  let now = await rows(ACC);
  check(r.stored === 1, `a push with one change should store 1 envelope, stored ${r.stored}`);
  check(now.get('/status').envelope.data.n === 2, 'the changed envelope was not stored');
  check(
    JSON.stringify(now.get('/runs').envelope) === JSON.stringify(before.get('/runs').envelope),
    'an unchanged row lost its envelope',
  );
  for (const k of ['/runs', '/policy'])
    check(
      new Date(now.get(k).synced_at) > new Date(before.get(k).synced_at),
      `${k} was confirmed by the push but its synced_at did not move`,
    );

  // 3. Deletes and missing keys.
  r = await delta('fwr_mine', ['/status', '/runs'], {});
  now = await rows(ACC);
  check(!now.has('/policy') && now.size === 2, 'a key left out of p_keys should be deleted');
  await db.query(`delete from public.fw_mirror where account_id = $1 and key = '/runs'`, [ACC]);
  r = await delta('fwr_mine', ['/status', '/runs'], {});
  check(JSON.stringify(r.missing) === '["/runs"]', `a lost row should come back as missing: ${JSON.stringify(r.missing)}`);

  // 4. Stray envelopes and bad tokens.
  r = await delta('fwr_mine', ['/status'], { '/stray': env({}) });
  check(!(await rows(ACC)).has('/stray'), 'an envelope whose key is not in p_keys was stored');
  let refused = false;
  try {
    await delta('fwr_wrong', ['/status'], {});
  } catch {
    refused = true;
  }
  check(refused, 'a wrong runner token was accepted');

  // 5. The other business, and the old call.
  const theirs = await rows(OTHER);
  check(theirs.size === 1 && theirs.get('/status').envelope.data.whose === 'theirs', 'another business’s rows changed');
  await db.query('select public.fw_relay_ingest($1, $2, $3)', ['fwr_mine', all, {}]);
  check((await rows(ACC)).size === 3, 'the whole-snapshot call should still work');

  // 6. The helpers.
  const first = mirror.changedEntries(all, new Map());
  check(Object.keys(first.changed).length === 3, 'a first push should send every envelope');
  const again = { ...all, '/runs': { ...env([{ id: 'r1' }], '2026-11-18T10:05:00.000Z'), head_seq: 99 } };
  const second = mirror.changedEntries({ ...again, '/status': env({ n: 3 }) }, first.prints);
  check(
    JSON.stringify(Object.keys(second.changed)) === '["/status"]',
    `only changed data should be sent, got ${JSON.stringify(Object.keys(second.changed))}`,
  );
  const e = env({ a: 1 });
  check(
    mirror.freshEnvelope(e, '2026-11-18T10:09:00+00:00').as_of === '2026-11-18T10:09:00.000Z',
    'freshEnvelope should serve the later synced_at',
  );
  check(mirror.freshEnvelope(e, '2026-11-18T09:00:00+00:00').as_of === e.as_of, 'freshEnvelope should keep a newer as_of');

  // 7. The relay and the hosted /v1.
  const relay = readFileSync(join(root, 'hosted/relay/fw-relay.mjs'), 'utf8');
  check(/fw_relay_ingest_delta/.test(relay), 'hosted/relay/fw-relay.mjs does not call fw_relay_ingest_delta');
  check(/['"`]fw_relay_ingest['"`]/.test(relay), 'hosted/relay/fw-relay.mjs lost its whole-snapshot fallback');

  process.env.SUPABASE_URL = 'https://supa.example';
  process.env.SUPABASE_ANON_KEY = 'anon';
  const reads = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/auth/v1/user') return reply({ id: uid(1), email: 'owner@example.com' });
    if (url.pathname === '/rest/v1/rpc/fw_my_accounts') return reply([{ id: ACC, name: 'Mine', role: 'owner', flows: null }]);
    if (url.pathname === '/rest/v1/fw_mirror') {
      reads.push(decodeURIComponent(url.search));
      return reply([{ key: '/status', envelope: env({ n: 1 }), synced_at: '2026-11-18T10:30:00+00:00' }]);
    }
    return reply(url.pathname.startsWith('/rest/v1/rpc/') ? null : []);
  };
  const api = await import(`${pathToFileURL(join(root, 'api/v1.mjs')).href}?probe=${Date.now()}`);
  const res = await api.GET(
    new Request('https://flowweb.example/api/v1?__p=status', { headers: { authorization: 'Bearer user-token' } }),
  );
  const body = await res.json();
  check(res.status === 200, `GET /v1/status answered ${res.status}`);
  check(reads.length > 0 && reads.every((s) => s.includes('synced_at')), 'mirror reads should ask for synced_at');
  check(body.as_of === '2026-11-18T10:30:00.000Z', `a confirmed row should read as fresh as its push, got ${body.as_of}`);
});
