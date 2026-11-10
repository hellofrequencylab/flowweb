-- FlowWeb hosted: let the site choose which AI account each flow uses (FW-C-086), and change a project's
-- brief and labels (FW-C-087).
--
-- New kinds (FW-C-087): project.brief ({ what, who, voice, never, done }) and project.labels
-- ({ brand, category }), with the project id in draft_id and flow 'all'.
--
-- New kind: flow.ai ({ account: claude_plan | anthropic_key | chatgpt_plan | openai_key }). It names an
-- account only; keys stay in the keychain on the machine that runs the flow. The relay checks the request
-- again before it calls fwd (hosted/server/requests.mjs). Every kind 0005 allowed stays allowed.
alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in (
    'draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark', 'draft.approve',
    'flow.enable', 'flow.disable', 'flow.run', 'flow.dial', 'flow.block',
    'flow.schedule', 'flow.intensity', 'flow.ai',
    'project.brief', 'project.labels',
    'supervisor.pause', 'supervisor.resume',
    'hunt.save', 'hunt.run', 'hunt.remove'
  ));
