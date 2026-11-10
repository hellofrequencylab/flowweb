-- FlowWeb hosted: let the site change the email sender's settings (FW-C-095).
--
-- New kind: connection.email ({ mailboxes: [{ key, address, name }], postal, daily_cap, per_pass,
-- hours: { start, end, days } }), flow 'all', no draft. It never carries a password: those stay in the
-- keychain on the machine. The relay checks the request again before it calls fwd
-- (hosted/server/requests.mjs). It needs the 'control' action (owner or admin), as every non-draft kind does.
-- Every kind 0007 allowed stays allowed.
alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in (
    'draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark', 'draft.approve',
    'flow.enable', 'flow.disable', 'flow.run', 'flow.dial', 'flow.block',
    'flow.schedule', 'flow.intensity', 'flow.ai',
    'project.brief', 'project.labels',
    'connection.email',
    'supervisor.pause', 'supervisor.resume',
    'hunt.save', 'hunt.run', 'hunt.remove'
  ));
