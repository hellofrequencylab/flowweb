import type { FlowDraft } from '../api/types';

/** A slot the flow could not fill, such as {{venue_name}}. A draft with one cannot be sent as is. */
const SLOT = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/;

export function hasBlankSlot(d: FlowDraft): boolean {
  return SLOT.test(d.subject ?? '') || SLOT.test(d.body);
}

export interface DraftGroups {
  /** Waiting for you and complete: real people and events, ready to copy and send. */
  ready: FlowDraft[];
  /** Waiting for you but still holding {{slots}} the flow could not fill. */
  templates: FlowDraft[];
  /** Approved or rejected. */
  done: FlowDraft[];
}

const newestFirst = (a: FlowDraft, b: FlowDraft) =>
  (b.created_at ?? '').localeCompare(a.created_at ?? '') ||
  (a.subject ?? '').localeCompare(b.subject ?? '') ||
  a.id.localeCompare(b.id);

/** Ready drafts first, unfilled templates next, handled ones last; newest first inside each. */
export function groupDrafts(drafts: FlowDraft[]): DraftGroups {
  const out: DraftGroups = { ready: [], templates: [], done: [] };
  for (const d of drafts) {
    if (d.status !== 'waiting_for_owner') out.done.push(d);
    else if (hasBlankSlot(d)) out.templates.push(d);
    else out.ready.push(d);
  }
  out.ready.sort(newestFirst);
  out.templates.sort(newestFirst);
  out.done.sort(
    (a, b) =>
      (b.approved_at ?? b.rejected_at ?? '').localeCompare(a.approved_at ?? a.rejected_at ?? '') ||
      newestFirst(a, b),
  );
  return out;
}
