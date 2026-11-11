// FW-C-104: the outreach sequence. Every lead moves new -> touch1 -> touch2 (about day 5) -> touch3
// (about day 12) -> closed, and any reply or "no" closes it the same day. Three touches per person, ever.
// State lives in $FW_HOME/flows/<flow>/sequence.json; draft marks (sent, replied, declined), the
// do-not-contact list and the sender's outbox folders move it. Email touches go out only through
// a batch the Owner approves (part 2), at most 20 a day. DMs stay by hand.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Days after touch 1 that each touch is due: touch 1 at once, touch 2 about day 5, touch 3 about day 12. */
export const TOUCH_DAYS = [0, 5, 12] as const;
export const MAX_TOUCHES = 3;
/** The Owner's ceiling for batch-approved email touches a day (2026-11-11). Config may lower it. */
export const EMAIL_DAILY_CAP = 20;
const DAY = 86_400_000;
const EMAIL_ROUTES = new Set(['email', 'founder_email']);

export type SeqState = 'new' | 'touch1' | 'touch2' | 'touch3' | 'closed';
export type ClosedReason = 'replied' | 'declined' | 'do_not_contact' | 'three_touches';
export interface Touch {
  n: number;
  route: string;
  draft_id: string;
  sent_at: string | null;
  approved_at?: string;
  /** What the email sender did with it when it did not send: skipped, failed or held. */
  sender?: string;
}
export interface SeqLead {
  lead: string;
  email?: string;
  contact?: string;
  touches: Touch[];
  state: SeqState;
  next_due_at: string | null;
  closed_reason: ClosedReason | null;
  closed_at?: string;
}
export interface SequenceFile {
  leads: Record<string, SeqLead>;
  /** Email touches handed to the sender by batch approval: draft id -> when. Counts the daily cap. */
  handed_off: Record<string, string>;
}
export interface DueTouch {
  lead: string;
  n: number;
  /** The route for this touch: email when an earlier touch went another way and the lead has a public email. */
  route: string;
  previous_route: string;
  due_at: string;
  email?: string;
}

type Doc = Record<string, unknown>;
const str = (d: Doc, k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
const iso = (ms: number) => new Date(ms).toISOString();
const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const flowDir = (fwHome: string, flow: string) => join(fwHome, 'flows', flow);

function writeAtomic(path: string, doc: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadSequence(fwHome: string, flow: string): SequenceFile {
  const raw = readJson(join(flowDir(fwHome, flow), 'sequence.json')) as Partial<SequenceFile> | null;
  return { leads: { ...(raw?.leads ?? {}) }, handed_off: { ...(raw?.handed_off ?? {}) } };
}

function saveSequence(fwHome: string, flow: string, s: SequenceFile): void {
  mkdirSync(flowDir(fwHome, flow), { recursive: true, mode: 0o700 });
  writeAtomic(join(flowDir(fwHome, flow), 'sequence.json'), s);
}

function readDrafts(fwHome: string, flow: string): Doc[] {
  const dir = join(flowDir(fwHome, flow), 'drafts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f)) as Doc | null)
    .filter((d): d is Doc => !!d && typeof d.id === 'string')
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

/** The route a draft goes by: its send_via (hunt drafts), else its channel. */
export const routeOf = (d: Doc): string => str(d, 'send_via') ?? str(d, 'channel') ?? 'unknown';
export const isEmailRoute = (route: string) => EMAIL_ROUTES.has(route);

/** The lead a draft belongs to: an explicit sequence_lead, its lead id, its address, its contact page. */
export function leadKeyOf(d: Doc): string {
  const lead = str(d, 'lead_id');
  const k =
    str(d, 'sequence_lead') ??
    (lead && !lead.startsWith('template:') ? lead : null) ??
    str(d, 'to') ??
    str(d, 'contact_url') ??
    String(d.id);
  return k.toLowerCase();
}

const publicEmail = (d: Doc) => {
  const e = str(d, 'to') ?? str(d, 'public_email');
  return e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e.toLowerCase() : null;
};

function doNotContact(fwHome: string, flow: string): Set<string> {
  const s = readJson(join(flowDir(fwHome, flow), 'state.json')) as Doc | null;
  const list = Array.isArray(s?.do_not_contact) ? (s.do_not_contact as unknown[]) : [];
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/** What the sender did with handed-off items: id -> { folder, at }. */
function senderOutcomes(fwHome: string, flow: string): Map<string, { folder: string; at: string | null }> {
  const out = new Map<string, { folder: string; at: string | null }>();
  for (const folder of ['sent', 'skipped', 'failed', 'held']) {
    const dir = join(fwHome, 'outbox', flow, folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const doc = readJson(join(dir, f)) as Doc | null;
      const at = (doc?.sender as Doc | undefined)?.at;
      out.set(f.slice(0, -5), { folder, at: typeof at === 'string' ? at : null });
    }
  }
  return out;
}

/** The lead under key, made new when the sequence has not seen it. */
function leadOf(s: SequenceFile, key: string): SeqLead {
  const l = s.leads[key] ?? { lead: key, touches: [], state: 'new', next_due_at: null, closed_reason: null };
  s.leads[key] = l;
  return l;
}

function close(l: SeqLead, why: ClosedReason, at: string): void {
  // A reply or a no says more than "three touches done", so it replaces that reason.
  if (l.state === 'closed' && !(l.closed_reason === 'three_touches' && why !== 'three_touches')) return;
  l.state = 'closed';
  l.closed_reason = why;
  l.closed_at = at;
  l.next_due_at = null;
}

/** Recomputes state and next_due_at for one open lead from its touches. */
function advance(l: SeqLead): void {
  if (l.state === 'closed') return;
  const k = l.touches.length;
  l.state = k === 0 ? 'new' : (`touch${Math.min(k, 3)}` as SeqState);
  const last = l.touches[k - 1];
  if (k === 0 || !last?.sent_at) {
    l.next_due_at = null;
    return;
  }
  if (k >= MAX_TOUCHES) {
    close(l, 'three_touches', last.sent_at);
    return;
  }
  const first = Date.parse(l.touches[0]?.sent_at ?? last.sent_at);
  const at = TOUCH_DAYS[k] ?? 12;
  const gap = (at - (TOUCH_DAYS[k - 1] ?? 0)) * DAY;
  l.next_due_at = iso(Math.max(first + at * DAY, Date.parse(last.sent_at) + gap));
}

/**
 * Brings sequence.json up to date with the drafts, their marks, the do-not-contact list and the
 * sender's folders, and saves it. A sent draft that is not yet a touch becomes the lead's next touch,
 * never a fourth.
 */
export function syncSequence(fwHome: string, flow: string, now: Date = new Date()): SequenceFile {
  const s = loadSequence(fwHome, flow);
  const byDraft = new Map<string, string>();
  for (const l of Object.values(s.leads)) for (const t of l.touches) byDraft.set(t.draft_id, l.lead);
  const sender = senderOutcomes(fwHome, flow);
  const dnc = doNotContact(fwHome, flow);
  for (const d of readDrafts(fwHome, flow)) {
    const id = String(d.id);
    const out = sender.get(id);
    const sentAt = str(d, 'sent_at') ?? (out?.folder === 'sent' ? (out.at ?? now.toISOString()) : null);
    const key = byDraft.get(id) ?? leadKeyOf(d);
    let l = s.leads[key];
    if (!byDraft.has(id)) {
      if (!sentAt && !str(d, 'replied_at') && !str(d, 'declined_at')) continue;
      l = leadOf(s, key);
      if (l.state !== 'closed' && l.touches.length < MAX_TOUCHES) {
        l.touches.push({ n: l.touches.length + 1, route: routeOf(d), draft_id: id, sent_at: sentAt });
        byDraft.set(id, key);
      }
    }
    if (!l) continue;
    const t = l.touches.find((x) => x.draft_id === id);
    if (t && !t.sent_at && sentAt) t.sent_at = sentAt;
    if (t && out && out.folder !== 'sent') t.sender = out.folder;
    const email = publicEmail(d);
    const contact = str(d, 'contact_url');
    if (!l.email && email) l.email = email;
    if (!l.contact && contact) l.contact = contact;
    const replied = str(d, 'replied_at');
    const declined = str(d, 'declined_at');
    if (declined) close(l, 'declined', declined);
    else if (replied) close(l, 'replied', replied);
  }
  for (const l of Object.values(s.leads)) {
    const keys = [l.lead, l.email, l.contact, l.email ? `@${l.email.split('@')[1]}` : undefined];
    if (keys.some((k) => k && dnc.has(k.toLowerCase()))) close(l, 'do_not_contact', now.toISOString());
    advance(l);
  }
  saveSequence(fwHome, flow, s);
  return s;
}

/** The touches due now, soonest first, for the Today view and the cycle. A fourth touch is never due. */
export function dueTouches(flow: string, now: Date, fwHome: string): DueTouch[] {
  const s = syncSequence(fwHome, flow, now);
  const out: DueTouch[] = [];
  for (const l of Object.values(s.leads)) {
    if (l.state === 'closed' || !l.next_due_at || l.touches.length >= MAX_TOUCHES) continue;
    if (Date.parse(l.next_due_at) > now.getTime()) continue;
    const prev = l.touches[l.touches.length - 1]?.route ?? 'unknown';
    const route = !isEmailRoute(prev) && l.email ? 'email' : prev;
    out.push({
      lead: l.lead,
      n: l.touches.length + 1,
      route,
      previous_route: prev,
      due_at: l.next_due_at,
      ...(l.email ? { email: l.email } : {}),
    });
  }
  return out.sort((a, b) => a.due_at.localeCompare(b.due_at) || a.lead.localeCompare(b.lead));
}
