-- FlowWeb on flowweb.app: rename an agent or change its voice from the Team page (row FW-C-123).
--
-- New kind: team.edit (payload { team, role, name?, voice? }, null restores the default). The relay on the
-- Owner's machine calls POST /v1/team/{team}/{role} with it (hosted/server/requests.mjs). Also allows
-- flow.copy now, so multi-copy flows (FW-C-121) need no migration of their own. Both need the 'control'
-- action (owner or admin), as fw_action_of_kind already gives every non-draft kind. Only the allowed-kinds
-- check changes; every kind 0012 allowed stays allowed. Safe to run more than once.

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
    'team.edit'
  ));
