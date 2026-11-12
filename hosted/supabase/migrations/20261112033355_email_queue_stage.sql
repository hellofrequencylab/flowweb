-- FlowWeb: let the paired Owner stage an opted-in email template through the
-- existing local draft gate (FW-C-151). This candidate is additive and must
-- be reviewed before it is applied to any database.

alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in (
    'draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark', 'draft.approve',
    'flow.enable', 'flow.disable', 'flow.run', 'flow.dial', 'flow.block',
    'flow.schedule', 'flow.intensity', 'flow.ai',
    'flow.edit', 'flow.archive', 'flow.restore', 'flow.copy',
    'project.brief', 'project.labels',
    'connection.email',
    'supervisor.pause', 'supervisor.resume',
    'hunt.save', 'hunt.run', 'hunt.remove',
    'links.funnels',
    'team.edit',
    'email-queue.stage'
  ));

-- Staging marketing copy is stricter than general account controls: only the
-- account Owner can do it. In particular, an Admin or helper cannot queue it.
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
             when 'email_queue' then m.role = 'owner'
             else false
           end);
$$;

-- Preserve the existing draft/control routing and give the new request its
-- own Owner-only permission action.
create or replace function public.fw_action_of_kind(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'email-queue.stage' then 'email_queue'
    when p_kind like 'draft.%' then 'drafts'
    else 'control'
  end;
$$;
