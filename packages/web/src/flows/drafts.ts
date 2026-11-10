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
  /** You sent it: waiting on them, or they replied or said no. */
  sent: FlowDraft[];
  /** Approved or rejected. */
  done: FlowDraft[];
}

/** What happened after the Owner sent a draft, for its label. */
export function outcomeOf(d: FlowDraft): 'replied' | 'declined' | 'sent' | null {
  if (d.declined_at) return 'declined';
  if (d.replied_at) return 'replied';
  if (d.sent_at) return 'sent';
  return null;
}

const newestFirst = (a: FlowDraft, b: FlowDraft) =>
  (b.created_at ?? '').localeCompare(a.created_at ?? '') ||
  (a.subject ?? '').localeCompare(b.subject ?? '') ||
  a.id.localeCompare(b.id);

/** Ready drafts first, unfilled templates next, then sent, then handled; newest first inside each. */
export function groupDrafts(drafts: FlowDraft[]): DraftGroups {
  const out: DraftGroups = { ready: [], templates: [], sent: [], done: [] };
  for (const d of drafts) {
    if (d.status !== 'rejected' && d.sent_at) out.sent.push(d);
    else if (d.status !== 'waiting_for_owner') out.done.push(d);
    else if (hasBlankSlot(d)) out.templates.push(d);
    else out.ready.push(d);
  }
  out.ready.sort(newestFirst);
  out.templates.sort(newestFirst);
  out.sent.sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? '') || newestFirst(a, b));
  out.done.sort(
    (a, b) =>
      (b.approved_at ?? b.rejected_at ?? '').localeCompare(a.approved_at ?? a.rejected_at ?? '') ||
      newestFirst(a, b),
  );
  return out;
}
