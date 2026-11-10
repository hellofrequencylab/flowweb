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

/** FW-C-066: the one state word a draft shows in the inbox list. */
export type DraftState = 'Ready' | 'Has blanks' | 'Sent' | 'Replied' | 'Said no' | 'Approved' | 'Rejected';

export function stateOf(d: FlowDraft): DraftState {
  if (d.status === 'rejected') return 'Rejected';
  const o = outcomeOf(d);
  if (o === 'declined') return 'Said no';
  if (o === 'replied') return 'Replied';
  if (o === 'sent') return 'Sent';
  if (d.status !== 'waiting_for_owner') return 'Approved';
  return hasBlankSlot(d) ? 'Has blanks' : 'Ready';
}

/** Every draft in inbox order: ready first, then blanks, sent and handled, as groupDrafts sorts them. */
export function inboxOrder(drafts: FlowDraft[]): FlowDraft[] {
  const g = groupDrafts(drafts);
  return [...g.ready, ...g.templates, ...g.sent, ...g.done];
}

/** Who a draft is for, read from its greeting ("Hi Front Porch Gallery team,"), else null. */
export function recipientOf(d: FlowDraft): string | null {
  const m = /^\s*(?:hi|hello|hey|dear)\s+([^,\n!.]{2,48})[,\n!.]/i.exec(d.body);
  const who = m?.[1].trim();
  return who && !SLOT.test(who) ? who : null;
}

/** A short age for the list: "now", "5m", "3h", "2d", "4w". */
export function ageOf(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  if (m < 60 * 24 * 14) return `${Math.round(m / 1440)}d`;
  return `${Math.round(m / 10_080)}w`;
}

/** Drafts written per day for the last `days` days, oldest first, for the activity bars. */
export function draftsPerDay(drafts: FlowDraft[], days = 14, now = Date.now()): number[] {
  const out = new Array<number>(days).fill(0);
  const today = Math.floor(now / 86_400_000);
  for (const d of drafts) {
    const t = d.created_at ? Date.parse(d.created_at) : Number.NaN;
    if (Number.isNaN(t)) continue;
    const ago = today - Math.floor(t / 86_400_000);
    if (ago >= 0 && ago < days) out[days - 1 - ago] += 1;
  }
  return out;
}
