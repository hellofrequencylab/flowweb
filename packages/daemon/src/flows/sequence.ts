// FW-C-104: the outreach sequence. Every lead moves new -> touch1 -> touch2 (about day 5) -> touch3
// (about day 12) -> closed, and any reply or "no" closes it the same day. Three touches per person, ever;
// a cold lead (found by a hunt, never warmed) stops at sequence.cold_max_touches, two by default.
// State lives in $FW_HOME/flows/<flow>/sequence.json; draft marks (sent, replied, declined), the
// do-not-contact list and the sender's outbox folders move it. Email touches go out only through
// batchApprove, after the Owner approves the batch, at most 20 a day. DMs stay by hand.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writer } from '@fw/eventlog';
import { handOff, SupervisorError } from '../overseer/index.ts';
import { restricted } from './draft-gate.ts';
import { dncMatch, doNotContactList } from './opt-out.ts';

/** Days after touch 1 that each touch is due: touch 1 at once, touch 2 about day 5, touch 3 about day 12. */
export const TOUCH_DAYS = [0, 5, 12] as const;
export const MAX_TOUCHES = 3;
/**
 * The Owner's launch default (2026-11-11): a cold lead, one a hunt found and nobody warmed, gets at most
 * two touches, day 0 and about day 5. Config sequence.cold_max_touches may set 1 to 3.
 */
export const COLD_MAX_TOUCHES = 2;
/** The Owner's ceiling for batch-approved email touches a day (2026-11-11). Config may lower it. */
export const EMAIL_DAILY_CAP = 20;
const DAY = 86_400_000;
const EMAIL_ROUTES = new Set(['email', 'founder_email']);

export type SeqState = 'new' | 'touch1' | 'touch2' | 'touch3' | 'closed';
export type ClosedReason = 'replied' | 'declined' | 'do_not_contact' | 'three_touches' | 'cold_touches';
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
  /** A hunt found this lead and no draft marked it warm: it stops at the cold cap. */
  cold?: boolean;
  warm?: boolean;
  /** A draft carried an opt-in marker (opted_in_at, or opt_in true) for this lead's address. */
  opted_in?: boolean;
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

/** The sequence settings syncSequence and dueTouches need; the defaults keep the lifetime cap only. */
export interface SeqRules {
  cold_max_touches: number;
  email_opt_in_only: boolean;
}
const DEFAULT_RULES: SeqRules = { cold_max_touches: COLD_MAX_TOUCHES, email_opt_in_only: false };
const isWarm = (d: Doc) =>
  d.warm === true || [str(d, 'action'), str(d, 'touch_kind'), str(d, 'lead_kind')].includes('warm');
const isCold = (d: Doc) =>
  !!str(d, 'hunt_id') || str(d, 'action') === 'cold' || str(d, 'touch_kind') === 'cold';
const optedIn = (d: Doc) => !!str(d, 'opted_in_at') || d.opt_in === true;
/** How many touches this lead may get: the cold cap for a cold lead, else three. */
const capOf = (l: SeqLead, r: SeqRules) =>
  l.cold && !l.warm ? Math.min(r.cold_max_touches, MAX_TOUCHES) : MAX_TOUCHES;

function close(l: SeqLead, why: ClosedReason, at: string): void {
  // A reply or a no says more than "three touches done", so it replaces that reason.
  const capped = l.closed_reason === 'three_touches' || l.closed_reason === 'cold_touches';
  if (l.state === 'closed' && !(capped && why !== 'three_touches' && why !== 'cold_touches')) return;
  l.state = 'closed';
  l.closed_reason = why;
  l.closed_at = at;
  l.next_due_at = null;
}

/** Recomputes state and next_due_at for one open lead from its touches. */
function advance(l: SeqLead, r: SeqRules = DEFAULT_RULES): void {
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
  if (k >= capOf(l, r)) {
    close(l, 'cold_touches', last.sent_at);
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
export function syncSequence(
  fwHome: string,
  flow: string,
  now: Date = new Date(),
  rules: SeqRules = DEFAULT_RULES,
): SequenceFile {
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
    if (isWarm(d)) l.warm = true;
    else if (isCold(d) && l.touches[0]?.draft_id === id) l.cold = true;
    if (optedIn(d)) l.opted_in = true;
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
    advance(l, rules);
  }
  saveSequence(fwHome, flow, s);
  return s;
}

/** The touches due now, soonest first, for the Today view and the cycle. A fourth touch is never due. */
export function dueTouches(flow: string, now: Date, fwHome: string, repoRoot?: string): DueTouch[] {
  const rules = sequenceSettings(repoRoot, fwHome, flow);
  const s = syncSequence(fwHome, flow, now, rules);
  const out: DueTouch[] = [];
  for (const l of Object.values(s.leads)) {
    if (l.state === 'closed' || !l.next_due_at || l.touches.length >= MAX_TOUCHES) continue;
    if (Date.parse(l.next_due_at) > now.getTime()) continue;
    const prev = l.touches[l.touches.length - 1]?.route ?? 'unknown';
    // With email_opt_in_only, email is offered only to a lead that opted in; else the touch keeps its route.
    const mailOk = !rules.email_opt_in_only || l.opted_in === true;
    const route = !isEmailRoute(prev) && l.email && mailOk ? 'email' : prev;
    if (isEmailRoute(route) && !mailOk) continue;
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

/** The flow's sequence settings: config.json in $FW_HOME overrides the repo's (when a repo is given). */
export function sequenceSettings(repoRoot: string | undefined, fwHome: string, flow: string) {
  const home = join(flowDir(fwHome, flow), 'config.json');
  const path = existsSync(home) || !repoRoot ? home : join(repoRoot, 'flows', flow, 'config.json');
  const cfg = readJson(path) as Doc | null;
  const seq = (cfg?.sequence ?? {}) as Doc;
  const cap = seq.email_daily_cap;
  const cold = seq.cold_max_touches;
  return {
    /** A cold lead's touches (the Owner's launch default 2); the lifetime cap of three still holds. */
    cold_max_touches:
      Number.isInteger(cold) && (cold as number) >= 1
        ? Math.min(cold as number, MAX_TOUCHES)
        : COLD_MAX_TOUCHES,
    /** Email touches only for a lead that opted in (the Owner's launch default). */
    email_opt_in_only: seq.email_opt_in_only === true,
    /** The Owner's 2026-11-11 choice: email touches may be batch-approved while DMs stay on Draft. */
    email_batch_approval: seq.email_batch_approval === true,
    email_daily_cap:
      Number.isInteger(cap) && (cap as number) >= 1
        ? Math.min(cap as number, EMAIL_DAILY_CAP)
        : EMAIL_DAILY_CAP,
  };
}

export interface BatchResult {
  handed_off: string[];
  held: { id: string; reason: string }[];
  refused: { id: string; reason: string }[];
  cap: number;
  used_today: number;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * POST /v1/flows/{key}/batch/approve: the Owner approves a batch of email touches. Each one goes to the
 * sender's outbox through handOff, at most the daily cap in any 24 hours; the rest are held for a later
 * batch. A draft that is not an email touch, has no address, was rejected, or belongs to a closed lead
 * or a lead past three touches is refused. Approving the same draft twice changes nothing.
 */
export function batchApprove(o: {
  writer: Writer;
  repoRoot: string;
  fwHome: string;
  flow: string;
  draftIds: unknown;
  now?: Date;
}): BatchResult {
  const ids = o.draftIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((x) => typeof x === 'string'))
    throw new SupervisorError('INVALID', 'draft_ids must be a list of 1 to 100 draft ids');
  const now = o.now ?? new Date();
  const set = sequenceSettings(o.repoRoot, o.fwHome, o.flow);
  const s = syncSequence(o.fwHome, o.flow, now, set);
  const byDraft = new Map<string, SeqLead>();
  for (const l of Object.values(s.leads)) for (const t of l.touches) byDraft.set(t.draft_id, l);
  let used = Object.values(s.handed_off).filter((at) => now.getTime() - Date.parse(at) < DAY).length;
  const res: BatchResult = {
    handed_off: [],
    held: [],
    refused: [],
    cap: set.email_daily_cap,
    used_today: used,
  };
  const dir = join(flowDir(o.fwHome, o.flow), 'drafts');
  const dnc = doNotContactList(o.fwHome, o.flow);
  for (const id of new Set(ids as string[])) {
    const refuse = (reason: string) => res.refused.push({ id, reason });
    const path = join(dir, `${id}.json`);
    const d = ID.test(id) && existsSync(path) ? (readJson(path) as Doc | null) : null;
    if (!d) {
      refuse('not_found: no such draft');
      continue;
    }
    if (s.handed_off[id] || d.status === 'handed_off') {
      res.handed_off.push(id);
      continue;
    }
    const route = routeOf(d);
    const to = str(d, 'to');
    // FW-C-115: only a waiting draft, to someone not on do-not-contact and not in the EU, UK or Canada.
    const listed = dncMatch(dnc, d);
    const where = restricted({
      body: '',
      to,
      contact_url: str(d, 'contact_url'),
      country: str(d, 'country'),
      region: str(d, 'region'),
    });
    const blocks = (d.gate as Doc | undefined)?.blocks;
    const why = Array.isArray(blocks) ? blocks.map((b) => String((b as Doc)?.detail ?? '')).join('; ') : '';
    if (d.status === 'rejected') refuse('rejected: the Owner rejected this draft');
    else if (d.status === 'gate_blocked') refuse(`gate_blocked: ${why || 'this draft breaks a hard rule'}`);
    else if (d.status !== 'waiting_for_owner') refuse(`not_waiting: this draft is ${String(d.status)}`);
    else if (listed) refuse(`do_not_contact: ${listed} is on do-not-contact`);
    else if (where) refuse(`restricted_region: ${where} is a place the flow does not write to`);
    else if (!isEmailRoute(route)) refuse(`not_email: ${route} touches are sent by hand`);
    else if (!to || !publicEmail(d)) refuse('no_address: this draft has no email address');
    else {
      const l = byDraft.get(id) ?? s.leads[leadKeyOf(d)];
      const n = l ? l.touches.length + 1 : 1;
      if (l?.state === 'closed') refuse(`closed: this lead's sequence ended (${l.closed_reason})`);
      else if (n > MAX_TOUCHES) refuse('past_three_touches: three touches per person, ever');
      else if (l && n > capOf(l, set))
        refuse(`cold_touches: a cold lead gets ${set.cold_max_touches} touches`);
      else if (set.email_opt_in_only && !optedIn(d) && !l?.opted_in)
        refuse('no_opt_in: email goes only to an address that opted in');
      else if (l?.next_due_at && Date.parse(l.next_due_at) > now.getTime())
        refuse(`not_due: touch ${n} is due ${l.next_due_at}`);
      else if (l && l.touches.length > 0 && !l.touches[l.touches.length - 1]?.sent_at)
        refuse('touch_pending: the last touch has not gone out yet');
      else if (used >= set.email_daily_cap)
        res.held.push({ id, reason: `daily_cap: ${set.email_daily_cap} email touches a day` });
      else {
        const lead = {
          to,
          name: str(d, 'name'),
          subject: str(d, 'subject'),
          source_url: str(d, 'source_url'),
          ...(d.event ? { event: d.event } : {}),
          ...(str(d, 'region') ? { region: str(d, 'region') } : {}),
          ...(d.build === true ? { build: true } : {}),
          send_via: 'email',
          sequence_touch: n,
        };
        const r = handOff({
          writer: o.writer,
          repoRoot: o.repoRoot,
          fwHome: o.fwHome,
          flow: o.flow,
          item: { id, channel: String(d.channel ?? route), body: String(d.body ?? ''), lead },
          approved: true,
          batch: set.email_batch_approval,
          now,
        });
        if (r.outcome !== 'queued') {
          res.held.push({ id, reason: r.reason });
          continue;
        }
        const at = now.toISOString();
        const { held: _h, ...rest } = d;
        writeAtomic(path, { ...rest, status: 'handed_off', approved_at: at });
        const key = l?.lead ?? leadKeyOf(d);
        const lead2 = leadOf(s, key);
        const email = publicEmail(d);
        if (!lead2.email && email) lead2.email = email;
        lead2.touches.push({ n, route, draft_id: id, sent_at: null, approved_at: at });
        if (isCold(d) && lead2.touches.length === 0 && !isWarm(d)) lead2.cold = true;
        advance(lead2, set);
        byDraft.set(id, lead2);
        s.handed_off[id] = at;
        res.handed_off.push(id);
        used++;
      }
    }
  }
  res.used_today = used;
  saveSequence(o.fwHome, o.flow, s);
  return res;
}
