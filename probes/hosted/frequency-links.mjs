// Probe for FW-C-110 (a Frequency Space links to one FlowWeb business, and its signed funnel events reach
// that business's machine): `pnpm probe hosted/frequency-links`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: hosted/supabase/migrations/0001..0009 run in order inside PGlite (Postgres in WebAssembly, no
// server) under the same small stand-in for Supabase's auth schema as probes/hosted/accounts.mjs, so row
// level security and grants are checked for real; and hosted/server/frequency-link.mjs (sign, EVENT_TYPES),
// so the database and the shared contract agree.
//
// The surface this probe expects:
//   Migration 0009 adds fw_frequency_links (one per business and one per Space, status active | paused |
//   revoked, a secret no role can read), fw_plugin_events and fw_handoff_nonces. Functions:
//     fw_create_frequency_link(account, space_id, house) -> (link_id, secret 'fwl_...'), owner or admin only
//     fw_rotate_frequency_link(link) -> new secret; fw_set_frequency_link_status(link, status)
//     fw_plugin_ingest(link, ts, body, signature) -> event id, callable by anyone; refuses with the
//       messages unknown_link | paused | stale | bad_signature | bad_event; the same signed body twice
//       gives the same id once stored
//     fw_relay_take_events(runner_token, limit) -> (id, type, body, received_at), only that machine's
//       business, each event once
//     fw_plugin_use_nonce(link, nonce, expires_at) -> true once, then false; not callable by anon or
//       authenticated
//
// Proves, in order:
//   1. An owner links their business to a Space and gets the secret once; a helper and a stranger cannot.
//   2. Nobody signed in can read the secret column, and a member sees their link but not another's.
//   3. An event signed with the link's secret (by frequency-link.mjs sign) is stored for that business.
//   4. Unknown, paused, stale, tampered, wrong-Space and unknown-type events are refused with their reason.
//   5. A repeat of the same signed event is stored once.
//   6. The business's machine takes its events once; another business's machine gets none of them.
//   7. Rotating the secret retires the old one.
//   8. A handoff nonce works once and only the service role may use it.
//   9. The database's event types are exactly the contract's EVENT_TYPES.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'hosted/frequency-links';
const MIG = join(root, 'hosted/supabase/migrations');
const LINK_MOD = join(root, 'hosted/server/frequency-link.mjs');

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
  owner: { id: uid(1), email: 'owner@example.com' },
  helper: { id: uid(2), email: 'helper@example.com' },
  other: { id: uid(3), email: 'other@example.com' },
  stranger: { id: uid(4), email: 'stranger@example.com' },
};
const SPACE = 'space_house';
const OTHER_SPACE = 'space_other';

await probe(NAME, async () => {
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  if (!files.some((f) => f.startsWith('0009_')))
    missing('hosted/supabase/migrations has no 0009 migration for Frequency links (row FW-C-110)');

  const req = createRequire(join(root, 'package.json'));
  let PGlite;
  let pgcrypto;
  try {
    ({ PGlite } = await import(pathToFileURL(req.resolve('@electric-sql/pglite')).href));
    ({ pgcrypto } = await import(pathToFileURL(req.resolve('@electric-sql/pglite/contrib/pgcrypto')).href));
  } catch {
    missing('@electric-sql/pglite is not installed (pnpm install)');
  }
  const { sign, EVENT_TYPES } = await import(pathToFileURL(LINK_MOD).href);

  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUB);
  for (const p of Object.values(PEOPLE))
    await db.query('insert into auth.users (id, email) values ($1, $2)', [p.id, p.email]);
  for (const f of files.filter((x) => x <= '0009~')) await db.exec(readFileSync(join(MIG, f), 'utf8'));

  const as = async (who, sql, params = []) => {
    await db.exec('reset role');
    if (who === 'service') {
      await db.query(`select set_config('request.jwt.claims', '', false)`);
      await db.exec('set role service_role');
    } else {
      const p = who ? PEOPLE[who] : null;
      const claims = p ? JSON.stringify({ sub: p.id, email: p.email, role: 'authenticated' }) : '';
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
      await db.exec(p ? 'set role authenticated' : 'set role anon');
    }
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role');
    }
  };
  const refusal = async (who, sql, params = []) => {
    try {
      await as(who, sql, params);
      return null;
    } catch (e) {
      return String(e?.message ?? e);
    }
  };

  // Two businesses, each with a machine; the helper joins the owner's business.
  const [{ fw_create_account: acc }] = await as('owner', `select public.fw_create_account('House')`);
  const [{ fw_create_account: otherAcc }] = await as('other', `select public.fw_create_account('Other')`);
  const [{ fw_create_invite: invite }] = await as('owner', `select public.fw_create_invite($1, 'helper', $2, null)`, [
    acc,
    PEOPLE.helper.email,
  ]);
  await as('helper', 'select public.fw_accept_invite($1)', [invite]);
  const [{ fw_create_runner_token: runner }] = await as('owner', `select public.fw_create_runner_token($1, 'mac')`, [acc]);
  const [{ fw_create_runner_token: otherRunner }] = await as(
    'other',
    `select public.fw_create_runner_token($1, 'box')`,
    [otherAcc],
  );

  // 1. Making the link.
  check(
    (await refusal('helper', 'select * from public.fw_create_frequency_link($1, $2, true)', [acc, SPACE])) !== null,
    'a helper made a Frequency link; only owners and admins may',
  );
  check(
    (await refusal('stranger', 'select * from public.fw_create_frequency_link($1, $2, true)', [acc, SPACE])) !== null,
    'a stranger made a Frequency link for a business they are not in',
  );
  check(
    (await refusal(null, 'select * from public.fw_create_frequency_link($1, $2, true)', [acc, SPACE])) !== null,
    'an anonymous caller made a Frequency link',
  );
  const [made] = await as('owner', 'select * from public.fw_create_frequency_link($1, $2, true)', [acc, SPACE]);
  check(made?.link_id && /^fwl_[0-9a-f]{64}$/.test(made?.secret ?? ''), 'the owner did not get a link id and an fwl_ secret');
  const link = made.link_id;
  let secret = made.secret;
  check(
    (await refusal('owner', 'select * from public.fw_create_frequency_link($1, $2, false)', [acc, 'space_two'])) !== null,
    'one business was linked to two Spaces',
  );
  check(
    (await refusal('other', 'select * from public.fw_create_frequency_link($1, $2, true)', [otherAcc, SPACE])) !== null,
    'one Space was linked to two businesses',
  );
  const [otherMade] = await as('other', 'select * from public.fw_create_frequency_link($1, $2, false)', [
    otherAcc,
    OTHER_SPACE,
  ]);

  // 2. The secret stays in the database.
  for (const who of ['owner', 'helper', 'stranger', null])
    check(
      (await refusal(who, 'select secret from public.fw_frequency_links')) !== null,
      `${who ?? 'anon'} could read the link secret column`,
    );
  const helperSees = await as('helper', 'select id, space_id from public.fw_frequency_links');
  check(
    helperSees.length === 1 && helperSees[0].space_id === SPACE,
    `a helper should see only their business's link, saw ${JSON.stringify(helperSees)}`,
  );
  check(
    (await as('stranger', 'select id from public.fw_frequency_links')).length === 0,
    'a stranger can see a Frequency link',
  );

  // 3. A signed event is stored.
  const now = () => Math.floor(Date.now() / 1000);
  const event = (extra = {}) =>
    JSON.stringify({ type: 'host.started', at: new Date().toISOString(), space_id: SPACE, niche: 'yoga', ...extra });
  const send = (who, l, ts, body, sig) =>
    as(who, 'select public.fw_plugin_ingest($1, $2, $3, $4) as id', [l, String(ts), body, sig]);
  const sendRefusal = (l, ts, body, sig) =>
    refusal(null, 'select public.fw_plugin_ingest($1, $2, $3, $4)', [l, String(ts), body, sig]);

  const ts = now();
  const body = event();
  const [{ id: first }] = await send(null, link, ts, body, sign(secret, ts, body));
  check(first, 'a correctly signed event was not stored');
  const ownerEvents = await as('owner', 'select type, body from public.fw_plugin_events');
  check(
    ownerEvents.length === 1 && ownerEvents[0].type === 'host.started',
    `the owner should see the one event, saw ${JSON.stringify(ownerEvents)}`,
  );
  check((await as('other', 'select id from public.fw_plugin_events')).length === 0, "another business saw this business's event");

  // 4. Refusals, each with its reason.
  const expectReason = async (label, reason, l, t, b, s) => {
    const msg = await sendRefusal(l, t, b, s);
    check(msg !== null && msg.includes(reason), `${label}: expected "${reason}", got ${msg ?? 'accepted'}`);
  };
  await expectReason('unknown link', 'unknown_link', uid(99), ts, body, sign(secret, ts, body));
  await expectReason('stale', 'stale', link, ts - 400, body, sign(secret, ts - 400, body));
  await expectReason('future', 'stale', link, ts + 400, body, sign(secret, ts + 400, body));
  await expectReason('tampered', 'bad_signature', link, ts, event({ niche: 'run' }), sign(secret, ts, body));
  await expectReason('other secret', 'bad_signature', link, ts, body, sign(otherMade.secret, ts, body));
  const wrongSpace = event({ space_id: OTHER_SPACE });
  await expectReason('wrong Space', 'bad_event', link, ts, wrongSpace, sign(secret, ts, wrongSpace));
  const unknownType = event({ type: 'member.deleted' });
  await expectReason('unknown type', 'bad_event', link, ts, unknownType, sign(secret, ts, unknownType));
  await expectReason('not json', 'bad_event', link, ts, 'nope', sign(secret, ts, 'nope'));
  await as('owner', `select public.fw_set_frequency_link_status($1, 'paused')`, [link]);
  const pausedBody = event({ niche: 'paused' });
  await expectReason('paused', 'paused', link, ts, pausedBody, sign(secret, ts, pausedBody));
  check(
    (await refusal('helper', `select public.fw_set_frequency_link_status($1, 'active')`, [link])) !== null,
    'a helper changed the link status',
  );
  await as('owner', `select public.fw_set_frequency_link_status($1, 'active')`, [link]);

  // 5. The same signed event twice is stored once.
  const [{ id: again }] = await send(null, link, ts, body, sign(secret, ts, body));
  check(again === first, 'a repeated signed event did not answer with the first id');
  check((await as('owner', 'select id from public.fw_plugin_events')).length === 1, 'a repeated event was stored twice');

  // 6. Machines take their own events, once.
  const ts2 = now();
  const body2 = JSON.stringify({ type: 'event.rsvps_8', at: new Date().toISOString(), space_id: SPACE, rsvps: 8 });
  await send(null, link, ts2, body2, sign(secret, ts2, body2));
  check(
    (await as(null, 'select * from public.fw_relay_take_events($1, 50)', [otherRunner])).length === 0,
    "another business's machine took this business's events",
  );
  const taken = await as(null, 'select * from public.fw_relay_take_events($1, 50)', [runner]);
  check(
    taken.length === 2 && taken[0].type === 'host.started' && taken[1].type === 'event.rsvps_8',
    `the machine should take both events oldest first, took ${JSON.stringify(taken.map((t) => t.type))}`,
  );
  check(
    (await as(null, 'select * from public.fw_relay_take_events($1, 50)', [runner])).length === 0,
    'events were handed out twice',
  );
  check(
    (await refusal(null, 'select * from public.fw_relay_take_events($1, 50)', ['fwr_nope'])) !== null,
    'an unknown runner token took events',
  );

  // 7. Rotation retires the old secret.
  const [{ fw_rotate_frequency_link: rotated }] = await as('owner', 'select public.fw_rotate_frequency_link($1)', [link]);
  check(/^fwl_[0-9a-f]{64}$/.test(rotated ?? '') && rotated !== secret, 'rotating did not give a new fwl_ secret');
  const ts3 = now();
  const body3 = event({ niche: 'after-rotate' });
  await expectReason('old secret after rotate', 'bad_signature', link, ts3, body3, sign(secret, ts3, body3));
  secret = rotated;
  const [{ id: afterRotate }] = await send(null, link, ts3, body3, sign(secret, ts3, body3));
  check(afterRotate, 'the new secret did not work after rotating');

  // 8. Handoff nonces.
  const nonce = 'n'.repeat(24);
  const soon = new Date(Date.now() + 60_000).toISOString();
  for (const who of [null, 'owner'])
    check(
      (await refusal(who, 'select public.fw_plugin_use_nonce($1, $2, $3)', [link, nonce, soon])) !== null,
      `${who ?? 'anon'} could use a handoff nonce; only the service role may`,
    );
  const [{ fw_plugin_use_nonce: once }] = await as('service', 'select public.fw_plugin_use_nonce($1, $2, $3)', [
    link,
    nonce,
    soon,
  ]);
  const [{ fw_plugin_use_nonce: twice }] = await as('service', 'select public.fw_plugin_use_nonce($1, $2, $3)', [
    link,
    nonce,
    soon,
  ]);
  check(once === true && twice === false, `a nonce should work once then fail, got ${once} then ${twice}`);
  const past = new Date(Date.now() - 1000).toISOString();
  const [{ fw_plugin_use_nonce: late }] = await as('service', 'select public.fw_plugin_use_nonce($1, $2, $3)', [
    link,
    'm'.repeat(24),
    past,
  ]);
  check(late === false, 'an expired handoff nonce was accepted');

  // 9. The database and the contract agree on the event types.
  const [{ types }] = (await db.query('select public.fw_plugin_event_types() as types')).rows;
  const a = [...types].sort().join(',');
  const b = [...EVENT_TYPES].sort().join(',');
  check(a === b, `database event types differ from frequency-link.mjs EVENT_TYPES:\n  db:       ${a}\n  contract: ${b}`);
});
