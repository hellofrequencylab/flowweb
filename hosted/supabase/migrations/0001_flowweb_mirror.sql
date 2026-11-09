-- FlowWeb hosted mirror (read-only copy of the Owner's local fwd).
--
-- fwd stays loopback-only on the Owner's machine and remains the only writer of the real
-- database. A relay on that machine pushes /v1 read responses here; the hosted site serves
-- them back, with their original as_of, to the signed-in Owner only.
--
-- No service-role key is needed anywhere: reads go through RLS with the Owner's own JWT,
-- and the relay writes through one SECURITY DEFINER function that checks a runner token.

create extension if not exists pgcrypto with schema extensions;

-- Who may read. Filled by hand (SQL editor); never from the app.
create table if not exists public.fw_owners (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

-- One row per /v1 path the relay copied, keyed by path plus sorted query string.
create table if not exists public.fw_mirror (
  key text primary key,
  envelope jsonb not null,
  runner_id uuid,
  synced_at timestamptz not null default now()
);

-- A machine allowed to push. Only the sha256 of its token is kept.
create table if not exists public.fw_runners (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  report jsonb not null default '{}'::jsonb,
  revoked_at timestamptz
);

alter table public.fw_owners enable row level security;
alter table public.fw_mirror enable row level security;
alter table public.fw_runners enable row level security;

create or replace function public.fw_is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.fw_owners o
    where o.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );
$$;

drop policy if exists owner_reads_owners on public.fw_owners;
create policy owner_reads_owners on public.fw_owners for select to authenticated using (public.fw_is_owner());
drop policy if exists owner_reads_mirror on public.fw_mirror;
create policy owner_reads_mirror on public.fw_mirror for select to authenticated using (public.fw_is_owner());
drop policy if exists owner_reads_runners on public.fw_runners;
create policy owner_reads_runners on public.fw_runners for select to authenticated using (public.fw_is_owner());

-- The Owner mints a runner token for a machine. Returned once, stored only as a hash.
create or replace function public.fw_create_runner_token(p_label text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  tok text;
begin
  if not public.fw_is_owner() then
    raise exception 'not the owner' using errcode = '42501';
  end if;
  tok := 'fwr_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.fw_runners (label, token_hash)
  values (left(coalesce(nullif(trim(p_label), ''), 'machine'), 80),
          encode(extensions.digest(tok, 'sha256'), 'hex'));
  return tok;
end;
$$;

create or replace function public.fw_revoke_runner(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.fw_is_owner() then
    raise exception 'not the owner' using errcode = '42501';
  end if;
  update public.fw_runners set revoked_at = now() where id = p_id and revoked_at is null;
end;
$$;

-- The relay pushes a full snapshot. Keys it no longer sends are removed, so the mirror
-- never shows a row that fwd has dropped. A bad or revoked token changes nothing.
create or replace function public.fw_relay_ingest(p_token text, p_entries jsonb, p_report jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
  n int;
begin
  select id into rid from public.fw_runners
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and revoked_at is null;
  if rid is null then
    raise exception 'unknown runner token' using errcode = '28000';
  end if;
  if jsonb_typeof(p_entries) <> 'object' then
    raise exception 'entries must be an object of key -> envelope' using errcode = '22023';
  end if;
  if pg_column_size(p_entries) > 20 * 1024 * 1024 then
    raise exception 'snapshot too large' using errcode = '54000';
  end if;

  delete from public.fw_mirror m
   where not (p_entries ? m.key);
  insert into public.fw_mirror (key, envelope, runner_id, synced_at)
  select e.key, e.value, rid, now() from jsonb_each(p_entries) e
  on conflict (key) do update
    set envelope = excluded.envelope, runner_id = excluded.runner_id, synced_at = excluded.synced_at;
  get diagnostics n = row_count;

  update public.fw_runners
     set last_seen_at = now(), report = coalesce(p_report, '{}'::jsonb)
   where id = rid;
  return jsonb_build_object('stored', n, 'synced_at', now());
end;
$$;

revoke all on public.fw_owners, public.fw_mirror, public.fw_runners from anon, authenticated;
revoke all on function public.fw_is_owner(), public.fw_create_runner_token(text), public.fw_revoke_runner(uuid), public.fw_relay_ingest(text, jsonb, jsonb) from public, anon, authenticated;
grant select on public.fw_mirror, public.fw_runners, public.fw_owners to authenticated;
grant execute on function public.fw_is_owner() to authenticated;
grant execute on function public.fw_create_runner_token(text) to authenticated;
grant execute on function public.fw_revoke_runner(uuid) to authenticated;
grant execute on function public.fw_relay_ingest(text, jsonb, jsonb) to anon, authenticated;
