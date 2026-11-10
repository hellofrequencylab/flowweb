-- FlowWeb hosted: let the site ask the Mac to mark a draft sent, replied or declined (FW-C-054).
-- Marking only stamps what the Owner did by hand; it never sends anything.
alter table public.fw_requests drop constraint if exists fw_requests_kind_check;
alter table public.fw_requests add constraint fw_requests_kind_check
  check (kind in ('draft.edit', 'draft.reject', 'draft.rewrite', 'draft.mark'));
