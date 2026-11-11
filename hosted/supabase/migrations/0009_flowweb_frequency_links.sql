-- FlowWeb hosted: Frequency links, funnel events and handoff nonces (FW-C-110).
--
-- One Frequency Space (the house included) links to one FlowWeb business. The link has its own signing
-- secret, so Frequency signs each call for that Space the way it signs today's webhooks: hex HMAC-SHA256 of
-- `${ts}.${body}` (docs/api/FREQUENCY-INTEGRATION-V1.md, hosted/server/frequency-link.mjs).
--
-- The secret has to be readable to check a signature, so it is kept here and never leaves the database:
-- no role can select the column, the owner sees it once when the link is made or rotated, and signatures
-- are checked inside fw_plugin_ingest. The hosted API still needs no service key for any of this.
--
-- Funnel events land in fw_plugin_events and wait for the business's own machine, which takes them with
-- its runner token the same way it takes queued requests (fw_relay_take), and writes them as flow files.
-- Handoff nonces make each Open in FlowWeb token work once; only the handoff server function uses them.

-- 1. Tables.
create table if not exists public.fw_frequency_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.fw_accounts (id) on delete cascade,
  space_id text not null unique check (space_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  house boolean not null default false,
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  secret text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  last_event_at timestamptz
);
-- Only one link can be the house.
create unique index if not exists fw_frequency_links_one_house on public.fw_frequency_links (house) where house;

create table if not exists public.fw_plugin_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.fw_accounts (id) on delete cascade,
  link_id uuid not null references public.fw_frequency_links (id) on delete cascade,
  type text not null,
  body jsonb not null,
  signature text not null,
  received_at timestamptz not null default now(),
  taken_at timestamptz,
  runner_id uuid,
  unique (link_id, signature)
);
create index if not exists fw_plugin_events_waiting on public.fw_plugin_events (account_id, received_at)
  where taken_at is null;

create table if not exists public.fw_handoff_nonces (
  nonce text primary key check (length(nonce) between 16 and 128),
  link_id uuid not null references public.fw_frequency_links (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz not null default now()
);

alter table public.fw_frequency_links enable row level security;
alter table public.fw_plugin_events enable row level security;
alter table public.fw_handoff_nonces enable row level security;

-- 2. Reads. Members see their business's link (never the secret) and its events; nobody reads nonces.
drop policy if exists member_reads_frequency_link on public.fw_frequency_links;
create policy member_reads_frequency_link on public.fw_frequency_links for select to authenticated
  using (public.fw_role(account_id) is not null);
drop policy if exists member_reads_plugin_events on public.fw_plugin_events;
create policy member_reads_plugin_events on public.fw_plugin_events for select to authenticated
  using (public.fw_role(account_id) is not null);

revoke all on public.fw_frequency_links, public.fw_plugin_events, public.fw_handoff_nonces
  from public, anon, authenticated;
grant select (id, account_id, space_id, house, status, created_at, rotated_at, last_event_at)
  on public.fw_frequency_links to authenticated;
grant select (id, account_id, link_id, type, body, received_at, taken_at)
  on public.fw_plugin_events to authenticated;

-- 3. The eleven funnel event types (frequency-link.mjs EVENT_TYPES).
create or replace function public.fw_plugin_event_types() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'host.started', 'launcher.stalled', 'space.published', 'event.filled', 'event.rsvps_8', 'event.second',
    'meter.80', 'host.opted_out', 'founding.purchased', 'showcase.consent', 'event.published'
  ]::text[];
$$;

-- 4. Owners and admins make, pause, rotate and revoke the link. The secret comes back once.
create or replace function public.fw_link_admin(p_account uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.fw_role(p_account), '') not in ('owner', 'admin') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.fw_new_link_secret() returns text
language sql volatile set search_path = '' as $$
  select 'fwl_' || encode(extensions.gen_random_bytes(32), 'hex');
$$;

create or replace function public.fw_create_frequency_link(p_account uuid, p_space_id text, p_house boolean default false)
returns table (link_id uuid, secret text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  s text := public.fw_new_link_secret();
  lid uuid;
begin
  perform public.fw_link_admin(p_account);
  if exists (select 1 from public.fw_frequency_links l where l.account_id = p_account and l.status <> 'revoked') then
    raise exception 'this business is already linked to a Space' using errcode = '23505';
  end if;
  if exists (select 1 from public.fw_frequency_links l where l.space_id = p_space_id and l.status <> 'revoked') then
    raise exception 'that Space is already linked to a business' using errcode = '23505';
  end if;
  delete from public.fw_frequency_links l
   where l.status = 'revoked' and (l.account_id = p_account or l.space_id = p_space_id);
  insert into public.fw_frequency_links (account_id, space_id, house, secret, created_by)
  values (p_account, p_space_id, coalesce(p_house, false), s, public.fw_uid())
  returning id into lid;
  return query select lid, s;
end;
$$;

create or replace function public.fw_rotate_frequency_link(p_link uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  acc uuid;
  s text := public.fw_new_link_secret();
begin
  select account_id into acc from public.fw_frequency_links where id = p_link and status <> 'revoked';
  if acc is null then
    raise exception 'unknown link' using errcode = '42704';
  end if;
  perform public.fw_link_admin(acc);
  update public.fw_frequency_links set secret = s, rotated_at = now() where id = p_link;
  return s;
end;
$$;

create or replace function public.fw_set_frequency_link_status(p_link uuid, p_status text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  acc uuid;
begin
  if p_status not in ('active', 'paused', 'revoked') then
    raise exception 'status must be active, paused or revoked' using errcode = '22023';
  end if;
  select account_id into acc from public.fw_frequency_links where id = p_link and status <> 'revoked';
  if acc is null then
    raise exception 'unknown link' using errcode = '42704';
  end if;
  perform public.fw_link_admin(acc);
  update public.fw_frequency_links set status = p_status where id = p_link;
end;
$$;

-- 5. Frequency's server sends a funnel event for a link. Anyone may call this; the signature decides.
-- Refusals carry the same reasons as frequency-link.mjs verify(): unknown_link, paused, stale,
-- bad_signature, plus bad_event for a body that is not one of the eleven events for this Space.
-- A repeat of the same signed body is accepted once and answered with the first event's id.
create or replace function public.fw_plugin_ingest(p_link uuid, p_ts text, p_body text, p_signature text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.fw_frequency_links;
  ts bigint;
  b jsonb;
  eid uuid;
begin
  select * into l from public.fw_frequency_links where id = p_link;
  if l.id is null or l.status = 'revoked' then
    raise exception 'unknown_link' using errcode = '28000';
  end if;
  if l.status = 'paused' then
    raise exception 'paused' using errcode = '28000';
  end if;
  if coalesce(p_ts, '') !~ '^[0-9]{1,12}$' then
    raise exception 'stale' using errcode = '28000';
  end if;
  ts := p_ts::bigint;
  if abs(extract(epoch from now())::bigint - ts) > 300 then
    raise exception 'stale' using errcode = '28000';
  end if;
  if lower(coalesce(p_signature, '')) is distinct from
     encode(extensions.hmac(p_ts || '.' || coalesce(p_body, ''), l.secret, 'sha256'), 'hex') then
    raise exception 'bad_signature' using errcode = '28000';
  end if;
  if length(p_body) > 16384 then
    raise exception 'bad_event' using errcode = '22023';
  end if;
  begin
    b := p_body::jsonb;
  exception when others then
    raise exception 'bad_event' using errcode = '22023';
  end;
  if jsonb_typeof(b) <> 'object'
     or not (b ->> 'type' = any (public.fw_plugin_event_types()))
     or b ->> 'space_id' is distinct from l.space_id then
    raise exception 'bad_event' using errcode = '22023';
  end if;
  if (select count(*) from public.fw_plugin_events e where e.link_id = l.id and e.taken_at is null) >= 5000 then
    raise exception 'too_many_waiting' using errcode = '54000';
  end if;
  insert into public.fw_plugin_events (account_id, link_id, type, body, signature)
  values (l.account_id, l.id, b ->> 'type', b, lower(p_signature))
  on conflict (link_id, signature) do nothing
  returning id into eid;
  if eid is null then
    select id into eid from public.fw_plugin_events where link_id = l.id and signature = lower(p_signature);
  end if;
  update public.fw_frequency_links set last_event_at = now() where id = l.id;
  return eid;
end;
$$;

-- 6. The business's machine takes its waiting events (oldest first), like fw_relay_take for requests.
-- Events taken more than 30 days ago are cleared.
create or replace function public.fw_relay_take_events(p_token text, p_limit int default 50)
returns table (id uuid, type text, body jsonb, received_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
  acc uuid;
begin
  select r.id, r.account_id into rid, acc from public.fw_runners r
   where r.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and r.revoked_at is null;
  if rid is null then
    raise exception 'unknown runner token' using errcode = '28000';
  end if;
  delete from public.fw_plugin_events e where e.account_id = acc and e.taken_at < now() - interval '30 days';
  return query
  with t as (
    update public.fw_plugin_events e
       set taken_at = now(), runner_id = rid
     where e.id in (
       select q.id from public.fw_plugin_events q
        where q.account_id = acc and q.taken_at is null
        order by q.received_at
        limit least(greatest(coalesce(p_limit, 50), 1), 200)
        for update skip locked)
    returning e.id, e.type, e.body, e.received_at)
  select t.id, t.type, t.body, t.received_at from t order by t.received_at;
end;
$$;

-- 7. A handoff nonce works once. Only the handoff server function (service role) calls this.
create or replace function public.fw_plugin_use_nonce(p_link uuid, p_nonce text, p_expires timestamptz)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  n text;
begin
  delete from public.fw_handoff_nonces where expires_at < now() - interval '1 day';
  if p_expires is null or p_expires < now() then
    return false;
  end if;
  insert into public.fw_handoff_nonces (nonce, link_id, expires_at)
  values (p_nonce, p_link, p_expires)
  on conflict (nonce) do nothing
  returning nonce into n;
  return n is not null;
end;
$$;

-- 8. Grants.
revoke all on function
  public.fw_plugin_event_types(), public.fw_link_admin(uuid), public.fw_new_link_secret(),
  public.fw_create_frequency_link(uuid, text, boolean), public.fw_rotate_frequency_link(uuid),
  public.fw_set_frequency_link_status(uuid, text), public.fw_plugin_ingest(uuid, text, text, text),
  public.fw_relay_take_events(text, int), public.fw_plugin_use_nonce(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.fw_create_frequency_link(uuid, text, boolean), public.fw_rotate_frequency_link(uuid),
  public.fw_set_frequency_link_status(uuid, text)
  to authenticated;
grant execute on function public.fw_plugin_ingest(uuid, text, text, text), public.fw_relay_take_events(text, int)
  to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fw_plugin_use_nonce(uuid, text, timestamptz) to service_role;
  end if;
end $$;
