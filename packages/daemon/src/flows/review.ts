// FW-C-056: the weekly review. Plain code, no model judging the numbers: it joins the flow's drafts with
// the outcomes pulled from Frequency (FW-C-055) per hunt, and proposes shifts toward what works. A hunt
// with 15 or more sent and nothing back is paused; max_sends moves between enabled hunts toward the ones
// that respond, and the enabled hunts' total never rises. Shifts wait for the Owner at Draft and Copilot;
// at confirmed Autopilot, with the kill switch off and the Supervisor running, the review applies them.
// A review never changes the weekly invite cap, the regions, the dial or policy, and sends nothing.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reader } from '@fw/eventlog';
import { confirmHash, ENGINES, readSettings, supervisorView } from '../overseer/index.ts';
import { type Hunt, loadHunts, MAX_SENDS, saveHunts } from './hunts.ts';
import { FLOW_KEY } from './neighborhood-activation.ts';
import { appendAdminLog, writeJsonAtomic } from './neighborhood-admin.ts';

/** Sent drafts with no response before a hunt is paused. */
export const PAUSE_AFTER = 15;
/** How many sends the pooled rate is worth when scoring a hunt (shrinks small samples toward the pool). */
const PRIOR_SENDS = 5;
/** Sends a hunt needs before its max_sends moves. */
const MIN_SENT = 8;

type Doc = Record<string, unknown>;
type OutcomeRow = {
  campaign: string | null;
  content: string | null;
  leads: number;
  members: number;
  hosts: number;
  paid: number;
};

export type HuntCard = {
  hunt_id: string;
  name: string;
  drafted: number;
  sent: number;
  replied: number;
  declined: number;
  leads: number;
  members: number;
  hosts: number;
  paid: number;
  responded: number;
  rate: number | null;
};
export type Shift = {
  id: string;
  kind: 'pause' | 'max_sends';
  hunt_id: string;
  from: number | boolean;
  to: number | boolean;
  why: string;
  status: 'proposed' | 'applied' | 'dismissed';
};
export type Review = {
  at: string;
  auto_apply: boolean;
  scorecard: { hunts: HuntCard[]; pooled_rate: number | null };
  shifts: Shift[];
  learnings: string[];
};

export class ReviewError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const dir = (fwHome: string) => join(fwHome, 'flows', FLOW_KEY);
const reviewPath = (fwHome: string) => join(dir(fwHome), 'review.json');
const isObj = (x: unknown): x is Doc => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (d: Doc, k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const pct = (r: number) => `${Math.round(r * 100)}%`;

function readJson(p: string): unknown {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
}

function loadDrafts(fwHome: string): Doc[] {
  const d = join(dir(fwHome), 'drafts');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(d, f)))
    .filter(isObj);
}

function loadOutcomeRows(fwHome: string): OutcomeRow[] {
  const raw = readJson(join(dir(fwHome), 'outcomes.json'));
  const rows = isObj(raw) && Array.isArray(raw.outcomes) ? raw.outcomes.filter(isObj) : [];
  return rows.map((r) => ({
    campaign: str(r, 'campaign'),
    content: str(r, 'content'),
    leads: num(r.leads),
    members: num(r.members),
    hosts: num(r.hosts),
    paid: num(r.paid),
  }));
}

/** Per hunt: what its drafts did, joined with Frequency's outcomes by draft tag (or by hunt id). */
export function scorecard(hunts: Hunt[], drafts: Doc[], outcomes: OutcomeRow[]): HuntCard[] {
  const byTag = new Map<string, OutcomeRow>();
  for (const o of outcomes) if (o.content) byTag.set(o.content, o);
  return hunts.map((h) => {
    const card: HuntCard = {
      hunt_id: h.id,
      name: h.name,
      drafted: 0,
      sent: 0,
      replied: 0,
      declined: 0,
      leads: 0,
      members: 0,
      hosts: 0,
      paid: 0,
      responded: 0,
      rate: null,
    };
    for (const d of drafts) {
      if (d.hunt_id !== h.id) continue;
      card.drafted++;
      const tag = str(d, 'tag');
      const o = tag ? byTag.get(tag) : undefined;
      const sent = !!str(d, 'sent_at') || !!str(d, 'replied_at') || !!str(d, 'declined_at');
      if (sent) card.sent++;
      if (str(d, 'replied_at')) card.replied++;
      if (str(d, 'declined_at')) card.declined++;
      if (o) {
        card.leads += o.leads;
        card.members += o.members;
        card.hosts += o.hosts;
        card.paid += o.paid;
      }
      if (sent && (str(d, 'replied_at') || (o && o.leads + o.members + o.hosts > 0))) card.responded++;
    }
    // Signups from links sent before drafts were tagged count toward the hunt, not a draft.
    for (const o of outcomes) {
      if (o.content || o.campaign !== h.id) continue;
      card.leads += o.leads;
      card.members += o.members;
      card.hosts += o.hosts;
      card.paid += o.paid;
    }
    card.rate = card.sent > 0 ? card.responded / card.sent : null;
    return card;
  });
}

const shiftId = (at: string, kind: string, hunt: string) =>
  `shf_${createHash('sha256').update(`${at}|${kind}|${hunt}`).digest('hex').slice(0, 12)}`;

/** The shifts this scorecard argues for. The enabled hunts' total max_sends never rises. */
export function proposeShifts(
  hunts: Hunt[],
  cards: HuntCard[],
  at: string,
): { shifts: Shift[]; pooled: number | null } {
  const card = new Map(cards.map((c) => [c.hunt_id, c]));
  const sent = cards.reduce((n, c) => n + c.sent, 0);
  const pooled = sent > 0 ? cards.reduce((n, c) => n + c.responded, 0) / sent : null;
  const shifts: Shift[] = [];
  const enabled = hunts.filter((h) => h.enabled !== false);
  const paused = new Set<string>();
  for (const h of enabled) {
    const c = card.get(h.id);
    if (!c || c.sent < PAUSE_AFTER || c.responded > 0) continue;
    paused.add(h.id);
    shifts.push({
      id: shiftId(at, 'pause', h.id),
      kind: 'pause',
      hunt_id: h.id,
      from: true,
      to: false,
      why: `${c.sent} sent and nothing back: no reply, lead or signup.`,
      status: 'proposed',
    });
  }
  // Move sends between the hunts that stay on and have enough sends to judge, by their shrunk rate.
  const keep = enabled.filter((h) => !paused.has(h.id) && (card.get(h.id)?.sent ?? 0) >= MIN_SENT);
  if (pooled !== null && keep.length >= 2) {
    const budget = keep.reduce((n, h) => n + h.max_sends, 0);
    const score = (h: Hunt) => {
      const c = card.get(h.id) as HuntCard;
      return (c.responded + PRIOR_SENDS * pooled) / (c.sent + PRIOR_SENDS);
    };
    const total = keep.reduce((n, h) => n + score(h), 0);
    if (total > 0) {
      const want = keep.map((h) => Math.max(1, Math.min(MAX_SENDS, Math.floor((budget * score(h)) / total))));
      keep.forEach((h, i) => {
        const to = want[i] as number;
        if (Math.abs(to - h.max_sends) < 2) return;
        const c = card.get(h.id) as HuntCard;
        shifts.push({
          id: shiftId(at, 'max_sends', h.id),
          kind: 'max_sends',
          hunt_id: h.id,
          from: h.max_sends,
          to,
          why: `${pct(c.rate ?? 0)} responded (${c.responded} of ${c.sent}), against ${pct(pooled)} across hunts.`,
          status: 'proposed',
        });
      });
    }
  }
  // Floors can push a total up; trim the raises until it is no higher than before.
  const raise = () =>
    shifts
      .filter((s) => s.kind === 'max_sends')
      .reduce((n, s) => n + (s.to as number) - (s.from as number), 0);
  for (const s of [...shifts].reverse()) {
    if (raise() <= 0) break;
    if (s.kind === 'max_sends' && (s.to as number) > (s.from as number))
      s.to = Math.max(s.from as number, (s.to as number) - raise());
  }
  return { shifts: shifts.filter((s) => s.kind === 'pause' || s.to !== s.from), pooled };
}

function learningsOf(cards: HuntCard[], pooled: number | null): string[] {
  const judged = cards.filter((c) => c.sent >= MIN_SENT).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
  const out: string[] = [];
  const best = judged[0];
  if (best && (best.rate ?? 0) > 0)
    out.push(
      `"${best.name}" works best: ${best.responded} of ${best.sent} sent responded, ${best.members} became members.`,
    );
  for (const c of judged.filter((x) => x.responded === 0 && x.sent >= PAUSE_AFTER))
    out.push(
      `"${c.name}" got nothing back from ${c.sent} sent; write to different organizers or a different angle.`,
    );
  if (pooled !== null) out.push(`Across hunts ${pct(pooled)} of sent drafts got a response.`);
  return out;
}

/** Whether the review may apply its own shifts: confirmed Autopilot, kill switch off, not paused. */
function mayAutoApply(reader: Reader, repoRoot: string, fwHome: string, now: Date): boolean {
  const view = supervisorView({ reader, repoRoot, fwHome, now: () => now });
  if (view.kill_switch || view.paused) return false;
  const set = readSettings(reader).flows[FLOW_KEY];
  if (set?.enabled !== true || set.dial !== 'autopilot') return false;
  try {
    const facts = ENGINES[FLOW_KEY]?.(repoRoot, fwHome, now);
    return !!facts && set.dial_hash === confirmHash(FLOW_KEY, facts);
  } catch {
    return false;
  }
}

function applyShift(fwHome: string, s: Shift, now: Date): void {
  const list = loadHunts(fwHome);
  const next = list.map((h) => {
    if (h.id !== s.hunt_id) return h;
    return s.kind === 'pause' ? { ...h, enabled: false } : { ...h, max_sends: s.to as number };
  });
  saveHunts(fwHome, next);
  const name = list.find((h) => h.id === s.hunt_id)?.name ?? s.hunt_id;
  const what =
    s.kind === 'pause' ? `paused "${name}"` : `set "${name}" to ${s.to} sends a run (was ${s.from})`;
  appendAdminLog(fwHome, {
    at: now.toISOString(),
    action: 'hunt',
    summary: `Weekly review ${what}: ${s.why}`,
  });
}

export function runReview(o: { reader: Reader; repoRoot: string; fwHome: string; now?: Date }): Review {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const hunts = loadHunts(o.fwHome);
  const cards = scorecard(hunts, loadDrafts(o.fwHome), loadOutcomeRows(o.fwHome));
  const { shifts, pooled } = proposeShifts(hunts, cards, at);
  const auto = mayAutoApply(o.reader, o.repoRoot, o.fwHome, now);
  if (auto)
    for (const s of shifts) {
      applyShift(o.fwHome, s, now);
      s.status = 'applied';
    }
  const review: Review = {
    at,
    auto_apply: auto,
    scorecard: { hunts: cards, pooled_rate: pooled },
    shifts,
    learnings: learningsOf(cards, pooled),
  };
  writeJsonAtomic(reviewPath(o.fwHome), review);
  return review;
}

export function readReview(fwHome: string): Review | null {
  const r = readJson(reviewPath(fwHome));
  return isObj(r) ? (r as unknown as Review) : null;
}

/** The Owner applies or dismisses one proposed shift of the last review. */
export function decideShift(
  fwHome: string,
  id: string,
  action: 'apply' | 'dismiss',
  now = new Date(),
): Shift {
  const review = readReview(fwHome);
  const s = review?.shifts.find((x) => x.id === id);
  if (!review || !s) throw new ReviewError(404, `the last review has no shift ${id}`);
  if (s.status !== 'proposed') throw new ReviewError(409, `this shift is already ${s.status}`);
  if (action === 'apply') applyShift(fwHome, s, now);
  s.status = action === 'apply' ? 'applied' : 'dismissed';
  writeJsonAtomic(reviewPath(fwHome), review);
  return s;
}
