// FW-C-105: Today. One ranked list of the actions the Owner works each morning, built from what the flow
// already has on disk: its waiting drafts ($FW_HOME/flows/<flow>/drafts/), the lead graph (leads.json, when
// it exists), the sequence engine's due dates (sequence.json, when it exists) and show up suggestions
// (show-up.json, when it exists). Read only: nothing here writes a draft, a lead or a sequence. The one
// file it writes is skips.jsonl, the reason the Owner gave for each skip, for the weekly review.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dncMatch, doNotContactList } from './opt-out.ts';

/** The day's size by default, the most the intensity control may raise it to, and how long a draft lasts. */
export const TODAY_SIZE = 15;
export const TODAY_MAX = 25;
export const TODAY_MAX_AGE_MS = 3 * 86_400_000;
/** At most this many evenings out a day; the plan allows two a week. */
const SHOW_UP_MAX = 2;

export const SKIP_REASONS = ['wrong_niche', 'not_local', 'not_a_fit', 'on_frequency'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const isSkipReason = (v: unknown): v is SkipReason => (SKIP_REASONS as readonly unknown[]).includes(v);

export type TodayKind = 'cold' | 'sequence' | 'warm' | 'venue' | 'approve_lead' | 'show_up';
export type TodayRoute = 'email' | 'dm' | 'form' | 'platform';

export interface TodayAction {
  id: string;
  kind: TodayKind;
  draft_id: string | null;
  lead_id: string | null;
  name: string;
  niche: string | null;
  angle: string | null;
  town: string | null;
  source_url: string | null;
  route: TodayRoute | null;
  /** What Copy and open opens in a new tab: mailto, the DM profile or the contact form. */
  open_url: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  words: number | null;
  /** The lead score's value when leads.json exists, else null. */
  score: number | null;
  touch: number | null;
  due_at: string | null;
  created_at: string | null;
}

export interface TodayView {
  flow: string;
  size: number;
  ranked_by: 'score' | 'age';
  actions: TodayAction[];
  /** Actions that could be on the list today, before the size cut. */
  eligible: number;
  /** Waiting drafts left off because they are more than 3 days old (kept on disk). */
  expired: number;
  /** Skips recorded today, by reason. */
  skips: Partial<Record<SkipReason, number>>;
}

type Doc = Record<string, unknown>;
const obj = (v: unknown): Doc | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : null);
const text = (d: Doc | null | undefined, k: string): string | null =>
  d && typeof d[k] === 'string' && (d[k] as string).trim() !== '' ? (d[k] as string) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const web = (v: string | null): string | null => (v && /^https?:\/\//i.test(v) ? v : null);
const time = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);
const SLOT = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/;

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The day's size: ?size when asked (1 to 25), else 15 raised by the intensity's people a day, at most 25. */
export function todaySize(perDay: number | null, asked?: string | null): number {
  const n = asked == null || asked === '' ? Number.NaN : Number(asked);
  if (Number.isInteger(n)) return Math.min(TODAY_MAX, Math.max(1, n));
  const fromIntensity = perDay ? Math.round(perDay * 1.5) : 0;
  return Math.min(TODAY_MAX, Math.max(TODAY_SIZE, fromIntensity));
}

interface Lead {
  id: string;
  state: string | null;
  score: number | null;
  kind: string | null;
  warm: boolean;
  doc: Doc;
}

/** leads.json from the lead graph: { nodes: [...] }, { leads: [...] } or a bare list. Null when absent. */
function readLeads(path: string): Lead[] | null {
  const raw = readJson(path);
  if (raw == null) return null;
  const list = Array.isArray(raw) ? raw : ((obj(raw)?.nodes ?? obj(raw)?.leads ?? []) as unknown[]);
  if (!Array.isArray(list)) return [];
  return list.flatMap((n) => {
    const d = obj(n);
    const id = text(d, 'id');
    if (!d || !id) return [];
    const score = num(d.score) ?? num(obj(d.score)?.value);
    return [{ id, state: text(d, 'state'), score, kind: text(d, 'kind'), warm: d.warm === true, doc: d }];
  });
}

interface Seq {
  state: string | null;
  touches: number;
  next_due_at: string | null;
}

/** sequence.json from the sequence engine, by lead id: a map, { leads: map or list } or a list. */
function readSequence(path: string): Map<string, Seq> | null {
  const raw = readJson(path);
  if (raw == null) return null;
  const inner = obj(raw)?.leads ?? raw;
  const pairs: [string, unknown][] = Array.isArray(inner)
    ? inner.map((e) => [text(obj(e), 'lead_id') ?? text(obj(e), 'id') ?? '', e])
    : Object.entries(obj(inner) ?? {});
  const out = new Map<string, Seq>();
  for (const [id, e] of pairs) {
    const d = obj(e);
    if (!id || !d) continue;
    const touches = Array.isArray(d.touches) ? d.touches.length : (num(d.touches) ?? 0);
    out.set(id, { state: text(d, 'state'), touches, next_due_at: text(d, 'next_due_at') });
  }
  return out;
}

const SEQ_ENDED = new Set(['closed', 'replied', 'declined', 'said_no', 'opted_out', 'done', 'stopped']);
const LEAD_PROPOSED = new Set(['proposed', 'borderline']);

function routeOf(d: Doc): TodayRoute | null {
  const r = (text(d, 'route') ?? text(d, 'send_via') ?? '').toLowerCase();
  if (r === 'email') return 'email';
  if (r === 'dm' || r === 'social' || r === 'instagram') return 'dm';
  if (r === 'form') return 'form';
  if (r === 'platform') return 'platform';
  if (text(d, 'to')) return 'email';
  return text(d, 'contact_url') ? 'form' : null;
}

function openUrl(route: TodayRoute | null, d: Doc): string | null {
  const to = text(d, 'to');
  if (route === 'email' && to) {
    const subject = text(d, 'subject');
    return `mailto:${to}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
  }
  return web(text(d, 'contact_url')) ?? web(text(d, 'source_url'));
}

function kindOf(d: Doc, lead: Lead | undefined, touch: number): TodayKind {
  const said = text(d, 'action') ?? text(d, 'touch_kind');
  if (said === 'cold' || said === 'sequence' || said === 'warm' || said === 'venue') return said;
  const leadKind = text(d, 'lead_kind') ?? lead?.kind ?? null;
  if (leadKind === 'venue') return 'venue';
  if (d.warm === true || lead?.warm || leadKind === 'warm') return 'warm';
  return touch > 1 ? 'sequence' : 'cold';
}

function readDrafts(dir: string): Doc[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    if (!f.endsWith('.json')) return [];
    const d = obj(readJson(join(dir, f)));
    return d && typeof d.id === 'string' ? [d] : [];
  });
}

/** Today's skips by reason, from skips.jsonl. */
function skipsToday(path: string, now: Date): Partial<Record<SkipReason, number>> {
  if (!existsSync(path)) return {};
  const out: Partial<Record<SkipReason, number>> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e: Doc | null = null;
    try {
      e = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const at = time(text(e, 'at'));
    if (!e || !isSkipReason(e.reason) || Number.isNaN(at)) continue;
    if (new Date(at).toDateString() !== now.toDateString()) continue;
    out[e.reason] = (out[e.reason] ?? 0) + 1;
  }
  return out;
}

/** Records why the Owner skipped a draft, for the weekly review. The draft itself is rejected elsewhere. */
export function recordSkip(o: {
  fwHome: string;
  flow: string;
  draftId: string;
  reason: SkipReason;
  now?: Date;
}) {
  const dir = join(o.fwHome, 'flows', o.flow);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = (o.now ?? new Date()).toISOString();
  appendFileSync(
    join(dir, 'skips.jsonl'),
    `${JSON.stringify({ at, draft_id: o.draftId, reason: o.reason })}\n`,
  );
}

/** The flow's Today list: ranked, cut at the day's size, drafts older than 3 days left off. */
export function todayView(o: { fwHome: string; flow: string; size: number; now?: Date }): TodayView {
  const now = o.now ?? new Date();
  const base = join(o.fwHome, 'flows', o.flow);
  const leads = readLeads(join(base, 'leads.json'));
  const seq = readSequence(join(base, 'sequence.json'));
  const byKey = new Map<string, Lead>();
  for (const l of leads ?? [])
    for (const k of [
      l.id,
      text(l.doc, 'email'),
      text(l.doc, 'to'),
      text(l.doc, 'contact_url'),
      text(l.doc, 'source_url'),
    ])
      if (k && !byKey.has(k.toLowerCase())) byKey.set(k.toLowerCase(), l);
  const leadOf = (d: Doc) =>
    ['lead_id', 'to', 'contact_url', 'source_url']
      .map((k) => text(d, k)?.toLowerCase())
      .map((k) => (k ? byKey.get(k) : undefined))
      .find(Boolean);

  const actions: TodayAction[] = [];
  const drafted = new Set<string>();
  const dnc = doNotContactList(o.fwHome, o.flow);
  let expired = 0;
  for (const d of readDrafts(join(base, 'drafts'))) {
    if (d.status !== 'waiting_for_owner') continue;
    if (text(d, 'sent_at') || text(d, 'replied_at') || text(d, 'declined_at')) continue;
    // FW-C-117: nobody on do-not-contact is offered, by address, page, lead or host.
    if (dncMatch(dnc, d)) continue;
    const body = text(d, 'body');
    const leadId = text(d, 'lead_id');
    if (!body || leadId?.startsWith('template:') || SLOT.test(body) || SLOT.test(text(d, 'subject') ?? ''))
      continue;
    const created = text(d, 'created_at');
    if (now.getTime() - time(created) > TODAY_MAX_AGE_MS) {
      expired += 1;
      continue;
    }
    const lead = leadOf(d);
    if (lead) drafted.add(lead.id);
    // The sequence keys a lead by its sequence_lead, lead id, address or contact page, lower case, so a
    // cold lead it closed at the cold cap (FW-C-114) drops off Today too.
    const s = [lead?.id, leadId, ...['sequence_lead', 'to', 'contact_url'].map((k) => text(d, k))]
      .flatMap((k) => (k ? [seq?.get(k) ?? seq?.get(k.toLowerCase())] : []))
      .find(Boolean);
    if (s?.state && SEQ_ENDED.has(s.state)) continue;
    if (s?.next_due_at && time(s.next_due_at) > now.getTime()) continue;
    const touch = num(d.touch) ?? (s ? s.touches + 1 : 1);
    const route = routeOf(d);
    const event = obj(d.event);
    actions.push({
      id: `draft:${d.id as string}`,
      kind: kindOf(d, lead, touch),
      draft_id: d.id as string,
      lead_id: lead?.id ?? leadId,
      name: text(d, 'name') ?? text(lead?.doc, 'name') ?? text(d, 'subject') ?? 'Unnamed lead',
      niche: text(d, 'niche') ?? text(lead?.doc, 'niche'),
      angle: text(d, 'angle'),
      town: text(d, 'town') ?? text(event, 'town') ?? text(lead?.doc, 'town') ?? text(d, 'region'),
      source_url: web(text(d, 'source_url')) ?? web(text(lead?.doc, 'source_url')),
      route,
      open_url: openUrl(route, d),
      to: text(d, 'to'),
      subject: text(d, 'subject'),
      body,
      words: body.trim().split(/\s+/).filter(Boolean).length,
      score: leads ? (lead?.score ?? 0) : null,
      touch,
      due_at: s?.next_due_at ?? null,
      created_at: created,
    });
  }

  // Borderline leads wait for one tap; a lead that already has a draft waiting is not asked about twice.
  for (const l of leads ?? []) {
    if (!l.state || !LEAD_PROPOSED.has(l.state) || drafted.has(l.id)) continue;
    actions.push({
      id: `lead:${l.id}`,
      kind: 'approve_lead',
      draft_id: null,
      lead_id: l.id,
      name: text(l.doc, 'name') ?? l.id,
      niche: text(l.doc, 'niche'),
      angle: null,
      town: text(l.doc, 'town'),
      source_url: web(text(l.doc, 'source_url')),
      route: null,
      open_url: web(text(l.doc, 'source_url')),
      to: null,
      subject: null,
      body: null,
      words: null,
      score: l.score ?? 0,
      touch: null,
      due_at: null,
      created_at: text(l.doc, 'created_at'),
    });
  }

  // Show up suggestions, when a flow writes them: at most two, never one already over.
  const shows = readJson(join(base, 'show-up.json'));
  const showList = Array.isArray(shows) ? shows : obj(shows)?.suggestions;
  let shown = 0;
  for (const e of Array.isArray(showList) ? showList : []) {
    const d = obj(e);
    const title = text(d, 'title');
    const starts = text(d, 'starts_at');
    if (!d || !title || shown >= SHOW_UP_MAX) continue;
    if (starts && time(starts) < now.getTime() - 2 * 3_600_000) continue;
    shown += 1;
    actions.push({
      id: `show:${text(d, 'id') ?? title}`,
      kind: 'show_up',
      draft_id: null,
      lead_id: null,
      name: title,
      niche: text(d, 'niche'),
      angle: null,
      town: text(d, 'town'),
      source_url: web(text(d, 'url')),
      route: null,
      open_url: web(text(d, 'url')),
      to: null,
      subject: null,
      body: text(d, 'why'),
      words: null,
      score: leads ? (num(d.score) ?? 0) : null,
      touch: null,
      due_at: starts,
      created_at: null,
    });
  }

  // Expected value first when the lead graph scores leads; otherwise the oldest first (it expires first).
  // A due sequence touch counts from its due date, so an overdue one comes before a fresh first touch.
  const when = (a: TodayAction) => {
    const t = time(a.kind === 'show_up' ? null : (a.due_at ?? a.created_at));
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const byAge = (a: TodayAction, b: TodayAction) => when(a) - when(b) || a.id.localeCompare(b.id);
  actions.sort(leads ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || byAge(a, b) : byAge);
  return {
    flow: o.flow,
    size: o.size,
    ranked_by: leads ? 'score' : 'age',
    actions: actions.slice(0, o.size),
    eligible: actions.length,
    expired,
    skips: skipsToday(join(base, 'skips.jsonl'), now),
  };
}
