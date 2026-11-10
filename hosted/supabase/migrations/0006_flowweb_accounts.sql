-- FlowWeb hosted: accounts, members and roles (FW-C-083).
--
-- Until now one hand-filled list (fw_owners) decided who could read one shared mirror. Now anyone can
-- make a login and a business (an account). Everything the site keeps belongs to one account: the
-- mirror the relay pushes, the machines allowed to push it, and the requests queued for them. People
-- join an account by invite, as a whole-business member or for named flows only.
--
-- Roles (hosted/server/accounts.mjs holds the same table for the screens):
--   owner   everything, including members, machines and deleting the account
--   admin   members (never owners), machines, flow controls, hunts and drafts
--   helper  works drafts: edit, rewrite, reject, mark, approve (approve only hands it to the outbox)
--   viewer  reads only
-- A member limited to flows (flows is not null) is a helper or viewer, sees only those flows' mirror
-- rows and can ask for changes on those flows only.
--
-- Existing data: if anything is here already, it all moves into one account, and every fw_owners
-- email that has a login becomes its owner. The relay token and the Mac keep working unchanged.
--
-- Row level security decides every read with the person's own token. Every write goes through a
-- SECURITY DEFINER function below that checks the caller's role first.

-- 1. Tables.
create table if not exists public.fw_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.fw_members (
  account_id uuid not null references public.fw_accounts (id) on delete cascade,
  user_id uuid not null,
  email text not null check (email = lower(email)),
  role text not null check (role in ('owner', 'admin', 'helper', 'viewer')),
  flows text[] check (flows is null or (cardinality(flows) between 1 and 50)),
  added_at timestamptz not null default now(),
  primary key (account_id, user_id),
  check (flows is null or role in ('helper', 'viewer'))
);
create index if not exists fw_members_user on public.fw_members (user_id);

create table if not exists public.fw_invites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.fw_accounts (id) on delete cascade,
  email text check (email is null or email = lower(email)),
  role text not null check (role in ('admin', 'helper', 'viewer')),
  flows text[] check (flows is null or (cardinality(flows) between 1 and 50)),
  token_hash text not null unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  check (flows is null or role in ('helper', 'viewer'))
);

-- 2. Which flow a mirror key is about (null for the whole business, like /status or /supervisor).
create or replace function public.fw_flow_of_key(p_key text) returns text
language sql immutable set search_path = '' as $$
  select substring(p_key from '^/(?:supervisor/)?flows/([a-z0-9][a-z0-9-]{0,63})(?:[/?]|$)');
$$;

alter table public.fw_mirror add column if not exists account_id uuid references public.fw_accounts (id) on delete cascade;
alter table public.fw_mirror add column if not exists flow_key text generated always as (public.fw_flow_of_key(key)) stored;
alter table public.fw_runners add column if not exists account_id uuid references public.fw_accounts (id) on delete cascade;
alter table public.fw_requests add column if not exists account_id uuid references public.fw_accounts (id) on delete cascade;

-- 3. Existing data moves into one account owned by the fw_owners logins.
do $$
declare
  acc uuid;
begin
  if exists (select 1 from public.fw_mirror where account_id is null)
     or exists (select 1 from public.fw_runners where account_id is null)
     or exists (select 1 from public.fw_requests where account_id is null)
     or exists (select 1 from public.fw_owners) then
    insert into public.fw_accounts (name) values ('My FlowWeb') returning id into acc;
    insert into public.fw_members (account_id, user_id, email, role)
    select acc, u.id, lower(u.email), 'owner'
      from auth.users u join public.fw_owners o on o.email = lower(u.email)
    on conflict do nothing;
    update public.fw_mirror set account_id = acc where account_id is null;
    update public.fw_runners set account_id = acc where account_id is null;
    update public.fw_requests set account_id = acc where account_id is null;
  end if;
end;
$$;

alter table public.fw_mirror alter column account_id set not null;
alter table public.fw_runners alter column account_id set not null;
alter table public.fw_requests alter column account_id set not null;
alter table public.fw_mirror drop constraint if exists fw_mirror_pkey;
alter table public.fw_mirror add primary key (account_id, key);
create index if not exists fw_requests_account_open on public.fw_requests (account_id, created_at) where status in ('queued', 'taken');

-- 4. Who the caller is in an account.
create or replace function public.fw_uid() returns uuid
language sql stable set search_path = '' as $$
  select case when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then null else auth.uid() end;
$$;

create or replace function public.fw_role(p_account uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.fw_members m where m.account_id = p_account and m.user_id = public.fw_uid();
$$;

-- May the caller see this account's data about p_flow (null = the whole business)?
create or replace function public.fw_can_see(p_account uuid, p_flow text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.fw_members m
     where m.account_id = p_account and m.user_id = public.fw_uid()
       and (m.flows is null or (p_flow is not null and p_flow = any (m.flows))));
$$;

-- May the caller do p_action (members, machines, control, drafts, rename, delete) on p_flow?
create or replace function public.fw_can(p_account uuid, p_action text, p_flow text default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.fw_members m
     where m.account_id = p_account and m.user_id = public.fw_uid()
       and (m.flows is null or (p_flow is not null and p_flow = any (m.flows)))
       and case p_action
             when 'delete' then m.role = 'owner'
             when 'members' then m.role in ('owner', 'admin')
             when 'machines' then m.role in ('owner', 'admin')
             when 'rename' then m.role in ('owner', 'admin')
             when 'control' then m.role in ('owner', 'admin')
             when 'drafts' then m.role in ('owner', 'admin', 'helper')
             else false
           end);
$$;

-- Which action a queued request kind needs.
create or replace function public.fw_action_of_kind(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case when p_kind like 'draft.%' then 'drafts' else 'control' end;
$$;

-- 5. Reads, by membership.
alter table public.fw_accounts enable row level security;
alter table public.fw_members enable row level security;
alter table public.fw_invites enable row level security;

drop policy if exists member_reads_accounts on public.fw_accounts;
create policy member_reads_accounts on public.fw_accounts for select to authenticated
  using (public.fw_role(id) is not null);
drop policy if exists member_reads_members on public.fw_members;
create policy member_reads_members on public.fw_members for select to authenticated
  using (public.fw_role(account_id) is not null);
drop policy if exists admin_reads_invites on public.fw_invites;
create policy admin_reads_invites on public.fw_invites for select to authenticated
  using (public.fw_can(account_id, 'members'));

drop policy if exists owner_reads_mirror on public.fw_mirror;
drop policy if exists member_reads_mirror on public.fw_mirror;
create policy member_reads_mirror on public.fw_mirror for select to authenticated
  using (public.fw_can_see(account_id, flow_key));
drop policy if exists owner_reads_runners on public.fw_runners;
drop policy if exists admin_reads_runners on public.fw_runners;
create policy admin_reads_runners on public.fw_runners for select to authenticated
  using (public.fw_can(account_id, 'machines'));
drop policy if exists owner_reads_requests on public.fw_requests;
drop policy if exists member_reads_requests on public.fw_requests;
create policy member_reads_requests on public.fw_requests for select to authenticated
  using (public.fw_can_see(account_id, nullif(flow, 'all')));

-- 6. Accounts and members.
create or replace function public.fw_create_account(p_name text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := public.fw_uid();
  acc uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if (select count(*) from public.fw_members where user_id = me and role = 'owner') >= 10 then
    raise exception 'you own 10 businesses already' using errcode = '54000';
  end if;
  insert into public.fw_accounts (name, created_by) values (btrim(p_name), me) returning id into acc;
  insert into public.fw_members (account_id, user_id, email, role)
  values (acc, me, lower(coalesce(auth.jwt() ->> 'email', '')), 'owner');
  return acc;
end;
$$;

create or replace function public.fw_my_accounts()
returns table (id uuid, name text, role text, flows text[])
language sql stable security definer set search_path = '' as $$
  select a.id, a.name, m.role, m.flows
    from public.fw_members m join public.fw_accounts a on a.id = m.account_id
   where m.user_id = public.fw_uid()
   order by a.created_at;
$$;

create or replace function public.fw_rename_account(p_account uuid, p_name text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.fw_can(p_account, 'rename') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.fw_accounts set name = btrim(p_name) where id = p_account;
end;
$$;

create or replace function public.fw_delete_account(p_account uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.fw_can(p_account, 'delete') then
    raise exception 'only an owner can delete the business' using errcode = '42501';
  end if;
  delete from public.fw_accounts where id = p_account;
end;
$$;

-- An invite link for an email (or anyone holding the link when p_email is null). Returned once.
create or replace function public.fw_create_invite(p_account uuid, p_role text, p_email text, p_flows text[])
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  tok text;
begin
  if not public.fw_can(p_account, 'members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  tok := 'fwi_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.fw_invites (account_id, email, role, flows, token_hash, created_by)
  values (p_account, nullif(lower(btrim(coalesce(p_email, ''))), ''), p_role,
          case when p_flows is null or cardinality(p_flows) = 0 then null else p_flows end,
          encode(extensions.digest(tok, 'sha256'), 'hex'), public.fw_uid());
  return tok;
end;
$$;

create or replace function public.fw_revoke_invite(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  acc uuid;
begin
  select account_id into acc from public.fw_invites where id = p_id;
  if acc is null or not public.fw_can(acc, 'members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.fw_invites set revoked_at = now() where id = p_id and accepted_at is null and revoked_at is null;
end;
$$;

-- The signed-in person joins with an invite link. An owner keeps owning; anyone else takes the invite's role.
create or replace function public.fw_accept_invite(p_token text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := public.fw_uid();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  inv public.fw_invites;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into inv from public.fw_invites
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;
  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'that invite is not valid any more' using errcode = '22023';
  end if;
  if inv.email is not null and inv.email <> mail then
    raise exception 'that invite is for a different email' using errcode = '42501';
  end if;
  insert into public.fw_members (account_id, user_id, email, role, flows)
  values (inv.account_id, me, mail, inv.role, inv.flows)
  on conflict (account_id, user_id) do update
    set role = excluded.role, flows = excluded.flows
    where public.fw_members.role <> 'owner';
  update public.fw_invites set accepted_by = me, accepted_at = now() where id = inv.id;
  return inv.account_id;
end;
$$;

-- Change someone's role or flows. Admins never touch owners or make owners. The last owner stays.
create or replace function public.fw_set_member(p_account uuid, p_user uuid, p_role text, p_flows text[])
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  mine text := public.fw_role(p_account);
  theirs text;
begin
  select role into theirs from public.fw_members where account_id = p_account and user_id = p_user for update;
  if theirs is null or not public.fw_can(p_account, 'members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if mine <> 'owner' and (theirs = 'owner' or p_role = 'owner') then
    raise exception 'only an owner can change owners' using errcode = '42501';
  end if;
  if theirs = 'owner' and p_role <> 'owner'
     and (select count(*) from public.fw_members where account_id = p_account and role = 'owner') = 1 then
    raise exception 'a business needs an owner' using errcode = '23514';
  end if;
  update public.fw_members
     set role = p_role,
         flows = case when p_flows is null or cardinality(p_flows) = 0 then null else p_flows end
   where account_id = p_account and user_id = p_user;
end;
$$;

-- Remove someone, or leave (p_user is the caller). Same owner rules as above.
create or replace function public.fw_remove_member(p_account uuid, p_user uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  mine text := public.fw_role(p_account);
  theirs text;
begin
  select role into theirs from public.fw_members where account_id = p_account and user_id = p_user for update;
  if theirs is null or mine is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_user <> public.fw_uid() and not public.fw_can(p_account, 'members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_user <> public.fw_uid() and mine <> 'owner' and theirs = 'owner' then
    raise exception 'only an owner can remove an owner' using errcode = '42501';
  end if;
  if theirs = 'owner'
     and (select count(*) from public.fw_members where account_id = p_account and role = 'owner') = 1 then
    raise exception 'a business needs an owner' using errcode = '23514';
  end if;
  delete from public.fw_members where account_id = p_account and user_id = p_user;
end;
$$;

-- 7. Machines belong to one account.
drop function if exists public.fw_create_runner_token(text);
create or replace function public.fw_create_runner_token(p_account uuid, p_label text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  tok text;
begin
  if not public.fw_can(p_account, 'machines') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  tok := 'fwr_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.fw_runners (account_id, label, token_hash)
  values (p_account, left(coalesce(nullif(btrim(p_label), ''), 'machine'), 80),
          encode(extensions.digest(tok, 'sha256'), 'hex'));
  return tok;
end;
$$;

create or replace function public.fw_revoke_runner(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  acc uuid;
begin
  select account_id into acc from public.fw_runners where id = p_id;
  if acc is null or not public.fw_can(acc, 'machines') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.fw_runners set revoked_at = now() where id = p_id and revoked_at is null;
end;
$$;

-- The relay's snapshot replaces its own account's mirror only.
create or replace function public.fw_relay_ingest(p_token text, p_entries jsonb, p_report jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
  acc uuid;
  n int;
begin
  select id, account_id into rid, acc from public.fw_runners
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
   where m.account_id = acc and not (p_entries ? m.key);
  insert into public.fw_mirror (account_id, key, envelope, runner_id, synced_at)
  select acc, e.key, e.value, rid, now() from jsonb_each(p_entries) e
  on conflict (account_id, key) do update
    set envelope = excluded.envelope, runner_id = excluded.runner_id, synced_at = excluded.synced_at;
  get diagnostics n = row_count;

  update public.fw_runners
     set last_seen_at = now(), report = coalesce(p_report, '{}'::jsonb)
   where id = rid;
  return jsonb_build_object('stored', n, 'synced_at', now());
end;
$$;

-- 8. Requests carry their account and check the caller's role.
drop function if exists public.fw_request(text, text, text, jsonb);
create or replace function public.fw_request(p_account uuid, p_kind text, p_flow text, p_draft_id text, p_payload jsonb)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
begin
  if not public.fw_can(p_account, public.fw_action_of_kind(p_kind), nullif(p_flow, 'all')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.fw_requests (account_id, kind, flow, draft_id, payload, created_by)
  values (p_account, p_kind, p_flow, p_draft_id, coalesce(p_payload, '{}'::jsonb),
          lower(coalesce(auth.jwt() ->> 'email', '')))
  returning id into rid;
  return rid;
end;
$$;

-- The relay takes only its own account's requests.
create or replace function public.fw_relay_take(p_token text, p_limit int default 10)
returns setof public.fw_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
  acc uuid;
begin
  select id, account_id into rid, acc from public.fw_runners
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and revoked_at is null;
  if rid is null then
    raise exception 'unknown runner token' using errcode = '28000';
  end if;
  update public.fw_requests set status = 'failed', error = 'expired: your machine did not pick this up within a day', done_at = now()
   where account_id = acc and status = 'queued' and created_at < now() - interval '1 day';
  return query
  update public.fw_requests r
     set status = 'taken', taken_at = now(), runner_id = rid
   where r.id in (
     select q.id from public.fw_requests q
      where q.account_id = acc
        and (q.status = 'queued' or (q.status = 'taken' and q.taken_at < now() - interval '15 minutes'))
      order by q.created_at
      limit least(greatest(coalesce(p_limit, 10), 1), 50)
      for update skip locked)
  returning r.*;
end;
$$;

-- 9. The old single-owner check stays defined (nothing grants by it now) so older clients fail closed.
drop policy if exists owner_reads_owners on public.fw_owners;
revoke all on public.fw_owners from authenticated;

revoke all on public.fw_accounts, public.fw_members, public.fw_invites from anon, authenticated;
grant select on public.fw_accounts, public.fw_members, public.fw_invites to authenticated;
revoke all on function
  public.fw_flow_of_key(text), public.fw_uid(), public.fw_role(uuid), public.fw_can_see(uuid, text),
  public.fw_can(uuid, text, text), public.fw_action_of_kind(text), public.fw_create_account(text),
  public.fw_my_accounts(), public.fw_rename_account(uuid, text), public.fw_delete_account(uuid),
  public.fw_create_invite(uuid, text, text, text[]), public.fw_revoke_invite(uuid), public.fw_accept_invite(text),
  public.fw_set_member(uuid, uuid, text, text[]), public.fw_remove_member(uuid, uuid),
  public.fw_create_runner_token(uuid, text), public.fw_request(uuid, text, text, text, jsonb)
  from public, anon;
grant execute on function
  public.fw_flow_of_key(text), public.fw_uid(), public.fw_role(uuid), public.fw_can_see(uuid, text),
  public.fw_can(uuid, text, text), public.fw_action_of_kind(text), public.fw_create_account(text),
  public.fw_my_accounts(), public.fw_rename_account(uuid, text), public.fw_delete_account(uuid),
  public.fw_create_invite(uuid, text, text, text[]), public.fw_revoke_invite(uuid), public.fw_accept_invite(text),
  public.fw_set_member(uuid, uuid, text, text[]), public.fw_remove_member(uuid, uuid),
  public.fw_create_runner_token(uuid, text), public.fw_request(uuid, text, text, text, jsonb)
  to authenticated;
