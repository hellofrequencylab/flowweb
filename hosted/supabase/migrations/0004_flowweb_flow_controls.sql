-- FlowWeb hosted: let the site ask the Mac to run a flow's controls (FW-C-062).
--
-- New kinds: turn a flow on or off, run it now, set its dial to Draft or Copilot, pause or resume the
-- Supervisor, approve a draft (hands it to the outbox; nothing is sent), save, run or remove a lead
-- hunt, and add an address to the do-not-contact list. Autopilot, the kill switch, budgets and policy
-- stay on the Owner's machine. The relay checks every request again before it calls fwd
-- (hosted/server/requests.mjs), so a kind allowed here still needs a matching fwd call there.
--
-- Pause and resume name the flow 'all' (the Supervisor itself), which the flow check already allows.
-- draft_id now holds the item a request is about (a draft or a hunt) and is empty for flow controls.
alter table public.fw_requests alter column draft_id drop not null;

alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in (
    'draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark', 'draft.approve',
    'flow.enable', 'flow.disable', 'flow.run', 'flow.dial', 'flow.block',
    'supervisor.pause', 'supervisor.resume',
    'hunt.save', 'hunt.run', 'hunt.remove'
  ));

