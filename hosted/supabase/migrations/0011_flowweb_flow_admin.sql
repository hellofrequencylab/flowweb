-- FlowWeb on flowweb.app: rename, note, archive and restore a flow from the site (row FW-C-116).
--
-- New kinds: flow.edit (payload { name?, note? }, null clears one), flow.archive and flow.restore (empty
-- payloads). The relay on the Owner's machine calls POST /v1/supervisor/flows/{key}/edit, /archive or
-- /restore with them (hosted/server/requests.mjs). They need the 'control' action (owner or admin), as
-- fw_action_of_kind already gives every non-draft kind. Only the allowed-kinds check changes; every kind
-- 0008 allowed stays allowed. Safe to run more than once.

alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in (
    'draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark', 'draft.approve',
    'flow.enable', 'flow.disable', 'flow.run', 'flow.dial', 'flow.block',
    'flow.schedule', 'flow.intensity', 'flow.ai',
    'flow.edit', 'flow.archive', 'flow.restore',
    'project.brief', 'project.labels',
    'connection.email',
    'supervisor.pause', 'supervisor.resume',
    'hunt.save', 'hunt.run', 'hunt.remove'
  ));
