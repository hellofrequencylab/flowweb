// FW-C-072: what's working, from the weekly review. The review scores its sent drafts by source, hunt,
// funnel, sub-area and message angle (dimensionsOf, written into review.json), and GET
// /v1/flows/{key}/review/summary answers the latest review as a short scorecard: the best and worst value
// per dimension among those with enough sent to judge, the flow's reply and signup rates, and the
// learnings. Plain code, read only: it never changes a hunt, a cap or the dial.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Sent drafts a value needs before it is named best or worst. */
export const MIN_SENT = 8;

export const DIMENSIONS = [
  { key: 'source', label: 'Source' },
  { key: 'hunt', label: 'Hunt' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'sub_area', label: 'Sub-area' },
  { key: 'angle', label: 'Message angle' },
] as const;
export type DimensionKey = (typeof DIMENSIONS)[number]['key'];

export type ValueCard = {
  value: string;
  name: string;
  sent: number;
  replied: number;
  signups: number;
  reply_rate: number | null;
  signup_rate: number | null;
};
export type Totals = Omit<ValueCard, 'value' | 'name'>;
export type ReviewBreakdown = { totals: Totals; by: Record<DimensionKey, ValueCard[]> };
export type DimensionSummary = {
  key: DimensionKey;
  label: string;
  tracked: boolean;
  judged: number;
  best: ValueCard | null;
  worst: ValueCard | null;
};
export type ReviewSummary = {
  flow: string;
  state: 'none' | 'thin' | 'ready';
  at: string | null;
  week: string | null;
  min_sent: number;
  sample_ok: boolean;
  totals: Totals;
  dimensions: DimensionSummary[];
  learnings: string[];
};

type Doc = Record<string, unknown>;
type HuntRef = { id: string; name: string; areas?: string[] };
type Outcome = { content: string | null; members: number; hosts: number };

const str = (d: Doc, k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
const isObj = (x: unknown): x is Doc => typeof x === 'object' && x !== null && !Array.isArray(x);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** The value a draft carries for each dimension, or null when it carries none. */
function valuesOf(d: Doc, hunts: Map<string, HuntRef>): Record<DimensionKey, string | null> {
  const hunt = hunts.get(str(d, 'hunt_id') ?? '');
  const lead = str(d, 'lead_id');
  const build = typeof d.build === 'boolean' ? (d.build ? 'claim page' : 'host funnel') : null;
  return {
    source: str(d, 'source') ?? hostOf(str(d, 'source_url')),
    hunt: hunt ? hunt.id : null,
    funnel: str(d, 'funnel') ?? (lead?.startsWith('template:') ? lead.slice(9) || null : null) ?? build,
    sub_area: str(d, 'sub_area') ?? (hunt?.areas?.length === 1 ? (hunt.areas[0] ?? null) : null),
    angle: str(d, 'angle'),
  };
}

const rates = (c: Totals): Totals => ({
  ...c,
  reply_rate: c.sent > 0 ? c.replied / c.sent : null,
  signup_rate: c.sent > 0 ? c.signups / c.sent : null,
});

/** Scores the flow's sent drafts per value of each dimension, joined with outcomes by draft tag. */
export function dimensionsOf(hunts: HuntRef[], drafts: Doc[], outcomes: Outcome[]): ReviewBreakdown {
  const byId = new Map(hunts.map((h) => [h.id, h]));
  const signedUp = new Set(
    outcomes.filter((o) => o.content && o.members + o.hosts > 0).map((o) => o.content),
  );
  const totals: Totals = { sent: 0, replied: 0, signups: 0, reply_rate: null, signup_rate: null };
  const maps = Object.fromEntries(DIMENSIONS.map((x) => [x.key, new Map<string, ValueCard>()])) as Record<
    DimensionKey,
    Map<string, ValueCard>
  >;
  for (const d of drafts) {
    if (!str(d, 'sent_at') && !str(d, 'replied_at') && !str(d, 'declined_at')) continue;
    const replied = str(d, 'replied_at') ? 1 : 0;
    const signup = signedUp.has(str(d, 'tag') ?? '') ? 1 : 0;
    totals.sent++;
    totals.replied += replied;
    totals.signups += signup;
    const vals = valuesOf(d, byId);
    for (const { key } of DIMENSIONS) {
      const v = vals[key];
      if (!v) continue;
      const name = key === 'hunt' ? (byId.get(v)?.name ?? v) : v;
      const card = maps[key].get(v) ?? {
        value: v,
        name,
        sent: 0,
        replied: 0,
        signups: 0,
        reply_rate: null,
        signup_rate: null,
      };
      card.sent++;
      card.replied += replied;
      card.signups += signup;
      maps[key].set(v, card);
    }
  }
  const by = Object.fromEntries(
    DIMENSIONS.map(({ key }) => [key, [...maps[key].values()].map((c) => rates(c) as ValueCard)]),
  ) as Record<DimensionKey, ValueCard[]>;
  return { totals: rates(totals), by };
}

/** ISO week of a timestamp, as YYYY-Www. */
export function isoWeek(at: string): string | null {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const order = (a: ValueCard, b: ValueCard) =>
  (b.reply_rate ?? 0) - (a.reply_rate ?? 0) ||
  (b.signup_rate ?? 0) - (a.signup_rate ?? 0) ||
  b.sent - a.sent ||
  a.name.localeCompare(b.name);

function summarize(key: DimensionKey, label: string, cards: ValueCard[] | undefined): DimensionSummary {
  const list = cards ?? [];
  const judged = list.filter((c) => c.sent >= MIN_SENT).sort(order);
  return {
    key,
    label,
    tracked: list.length > 0,
    judged: judged.length,
    best: judged[0] ?? null,
    worst: judged.length >= 2 ? (judged[judged.length - 1] ?? null) : null,
  };
}

const ZERO: Totals = { sent: 0, replied: 0, signups: 0, reply_rate: null, signup_rate: null };

/** The latest review of a flow as a short scorecard. A review from before FW-C-072 has no breakdown. */
export function reviewSummary(fwHome: string, flow: string): ReviewSummary {
  let raw: unknown = null;
  const p = join(fwHome, 'flows', flow, 'review.json');
  try {
    raw = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    raw = null;
  }
  const base = { flow, min_sent: MIN_SENT };
  if (!isObj(raw) || typeof raw.at !== 'string')
    return {
      ...base,
      state: 'none',
      at: null,
      week: null,
      sample_ok: false,
      totals: ZERO,
      dimensions: [],
      learnings: [],
    };
  const sc = isObj(raw.scorecard) ? raw.scorecard : {};
  const by = (isObj(sc.by) ? sc.by : {}) as Partial<Record<DimensionKey, ValueCard[]>>;
  const dimensions = DIMENSIONS.map(({ key, label }) =>
    summarize(key, label, Array.isArray(by[key]) ? by[key] : undefined),
  );
  const sampleOk = dimensions.some((d) => d.judged > 0);
  const totals = isObj(sc.totals) ? (sc.totals as Totals) : ZERO;
  const learnings = Array.isArray(raw.learnings) ? raw.learnings.filter((l) => typeof l === 'string') : [];
  return {
    ...base,
    state: sampleOk ? 'ready' : 'thin',
    at: raw.at,
    week: isoWeek(raw.at),
    sample_ok: sampleOk,
    totals,
    dimensions,
    learnings,
  };
}
