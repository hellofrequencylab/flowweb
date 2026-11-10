-- FlowWeb hosted: let the site set when a flow runs each morning and how many people it reaches a day
-- (FW-C-063).
--
-- New kinds: flow.schedule ({ time: 'HH:MM', days: 'daily' | 'weekdays' }) and flow.intensity
-- ({ per_day, auto, min, max }, each 1 to 25). Neither sends anything or touches the dial. The relay
-- checks every request again before it calls fwd (hosted/server/requests.mjs). Every kind 0004 allowed
-- stays allowed.
alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in (
    'draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark', 'draft.approve',
    'flow.enable', 'flow.disable', 'flow.run', 'flow.dial', 'flow.block',
    'flow.schedule', 'flow.intensity',
    'supervisor.pause', 'supervisor.resume',
    'hunt.save', 'hunt.run', 'hunt.remove'
  ));
