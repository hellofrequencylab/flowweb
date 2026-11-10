-- FlowWeb hosted requests: the few changes the Owner may ask for from the site.
--
-- The site never reaches the Owner's machine. It stores a request here; the relay on that
-- machine (outbound only) takes it, asks the local fwd to make the change with the CLI token,
-- and records the answer. Only draft changes are allowed: edit, reject and an AI rewrite.
-- Nothing here can approve, send, or change a flow, a budget or a policy.

create table if not exists public.fw_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('draft.edit', 'draft.reject', 'draft.rewrite')),
  flow text not null check (flow ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  draft_id text not null check (draft_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536),
  status text not null default 'queued' check (status in ('queued', 'taken', 'done', 'failed')),
  result jsonb,
  error text,
  runner_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz
);
create index if not exists fw_requests_open on public.fw_requests (created_at) where status in ('queued', 'taken');

alter table public.fw_requests enable row level security;
drop policy if exists owner_reads_requests on public.fw_requests;
create policy owner_reads_requests on public.fw_requests for select to authenticated using (public.fw_is_owner());

-- The Owner asks for a change. Answers the request id.
create or replace function public.fw_request(p_kind text, p_flow text, p_draft_id text, p_payload jsonb)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
begin
  if not public.fw_is_owner() then
    raise exception 'not the owner' using errcode = '42501';
  end if;
  insert into public.fw_requests (kind, flow, draft_id, payload, created_by)
  values (p_kind, p_flow, p_draft_id, coalesce(p_payload, '{}'::jsonb), lower(coalesce(auth.jwt() ->> 'email', '')))
  returning id into rid;
  return rid;
end;
$$;

-- The relay takes the waiting requests, oldest first. A request nobody took within a day
-- expires, and one taken but never finished within 15 minutes is offered again.
create or replace function public.fw_relay_take(p_token text, p_limit int default 10)
returns setof public.fw_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
begin
  select id into rid from public.fw_runners
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and revoked_at is null;
  if rid is null then
    raise exception 'unknown runner token' using errcode = '28000';
  end if;
  update public.fw_requests set status = 'failed', error = 'expired: your machine did not pick this up within a day', done_at = now()
   where status = 'queued' and created_at < now() - interval '1 day';
  return query
  update public.fw_requests r
     set status = 'taken', taken_at = now(), runner_id = rid
   where r.id in (
     select q.id from public.fw_requests q
      where q.status = 'queued' or (q.status = 'taken' and q.taken_at < now() - interval '15 minutes')
      order by q.created_at
      limit least(greatest(coalesce(p_limit, 10), 1), 50)
      for update skip locked)
  returning r.*;
end;
$$;

-- The relay records what fwd answered.
create or replace function public.fw_relay_finish(p_token text, p_id uuid, p_ok boolean, p_result jsonb, p_error text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
begin
  select id into rid from public.fw_runners
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and revoked_at is null;
  if rid is null then
    raise exception 'unknown runner token' using errcode = '28000';
  end if;
  update public.fw_requests
     set status = case when p_ok then 'done' else 'failed' end,
         result = case when p_ok then p_result else null end,
         error = case when p_ok then null else left(coalesce(p_error, 'failed'), 1000) end,
         done_at = now()
   where id = p_id and status = 'taken' and runner_id = rid;
end;
$$;

revoke all on public.fw_requests from anon, authenticated;
grant select on public.fw_requests to authenticated;
revoke all on function public.fw_request(text, text, text, jsonb), public.fw_relay_take(text, int), public.fw_relay_finish(text, uuid, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function public.fw_request(text, text, text, jsonb) to authenticated;
grant execute on function public.fw_relay_take(text, int) to anon, authenticated;
grant execute on function public.fw_relay_finish(text, uuid, boolean, jsonb, text) to anon, authenticated;
