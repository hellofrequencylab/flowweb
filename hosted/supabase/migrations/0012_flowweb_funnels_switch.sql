-- FlowWeb on flowweb.app: turn links to Frequency's funnel pages on or off from Settings (row FW-C-118).
--
-- New kind: links.funnels (payload { live: true | false | null }, null hands the choice back to the Mac's
-- FW_FUNNELS_LIVE and each flow's config). The relay on the Owner's machine calls
-- POST /v1/supervisor/funnels-live with it (hosted/server/requests.mjs). It needs the 'control' action (owner
-- or admin), as fw_action_of_kind already gives every non-draft kind. Only the allowed-kinds check changes;
-- every kind 0011 allowed stays allowed. Safe to run more than once.

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
    'hunt.save', 'hunt.run', 'hunt.remove',
    'links.funnels'
  ));
