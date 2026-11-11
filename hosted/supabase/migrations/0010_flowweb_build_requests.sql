-- FlowWeb hosted: build requests (FW-C-112).
--
-- When an owner or admin asks Kevin (the AI console) for something FlowWeb cannot do yet, Kevin writes it
-- up as a build request: a title, what they want, and how they will know it is done. The builder picks up
-- new requests, builds each one as a ledger row and pull request, and records the pull request here.
--
-- Members read their business's requests. Owners and admins add one through fw_build_request. Only the
-- builder (service_role, or the database owner) moves a request along with fw_set_build_request, so a
-- request can never mark itself done. Nothing here sends anything or changes a flow.

-- 1. The table.
create table if not exists public.fw_build_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.fw_accounts (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  what text not null check (length(btrim(what)) between 1 and 4000),
  done_when text not null default '' check (length(done_when) <= 1000),
  status text not null default 'new' check (status in ('new', 'building', 'pr_open', 'done', 'declined')),
  pr_url text check (pr_url is null or pr_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$'),
  note text check (note is null or length(note) <= 1000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fw_build_requests_account on public.fw_build_requests (account_id, created_at desc);
create index if not exists fw_build_requests_new on public.fw_build_requests (created_at) where status = 'new';

alter table public.fw_build_requests enable row level security;

-- 2. Reads: every member of the business.
drop policy if exists member_reads_build_requests on public.fw_build_requests;
create policy member_reads_build_requests on public.fw_build_requests for select to authenticated
  using (public.fw_role(account_id) is not null);

revoke all on public.fw_build_requests from public, anon, authenticated;
grant select on public.fw_build_requests to authenticated;

-- 3. Owners and admins add a request.
create or replace function public.fw_build_request(p_account uuid, p_title text, p_what text, p_done text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
begin
  if not public.fw_can(p_account, 'control') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.fw_build_requests (account_id, title, what, done_when, created_by)
  values (p_account, btrim(p_title), btrim(p_what), btrim(coalesce(p_done, '')), public.fw_uid())
  returning id into rid;
  return rid;
end;
$$;

-- 4. The builder moves a request along and records its pull request.
create or replace function public.fw_set_build_request(p_id uuid, p_status text, p_pr_url text, p_note text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.fw_build_requests
     set status = p_status,
         pr_url = coalesce(p_pr_url, pr_url),
         note = coalesce(p_note, note),
         updated_at = now()
   where id = p_id;
  if not found then
    raise exception 'unknown build request' using errcode = '42704';
  end if;
end;
$$;

-- 5. Grants.
revoke all on function public.fw_build_request(uuid, text, text, text), public.fw_set_build_request(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fw_build_request(uuid, text, text, text) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fw_set_build_request(uuid, text, text, text) to service_role;
  end if;
end $$;
