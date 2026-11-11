// FW-C-122: the token meter. Every model turn fwd starts for a flow is written once to
// $FW_HOME/meter/turns.jsonl (fwd is its only writer), tagged with the flow, the step and the item it was
// for. meterView turns it into the number that decides spend: tokens and dollars per outcome, per flow and
// per model, with the window's whole spend in the numerator so waste counts.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowRef } from './copies.ts';

export const STEPS = ['cycle', 'rewrite', 'reply', 'intake'] as const;
export type Step = (typeof STEPS)[number];
export const OUTCOMES = ['drafted', 'sent', 'replied', 'signed_up'] as const;
type Outcome = (typeof OUTCOMES)[number];

export interface Turn {
  at: string;
  flow: string;
  step: Step;
  item: string;
  vendor: string | null;
  model: string | null;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  usd: number;
  drafts: string[];
}

/** What an adapter result says a turn cost. */
export interface TurnCost {
  input_tokens?: number;
  cached_tokens?: number;
  output_tokens?: number;
  usd?: number;
}

const file = (fwHome: string) => join(fwHome, 'meter', 'turns.jsonl');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Meters one turn. Never throws: a meter that cannot write must not fail the turn it measures. */
export function meterTurn(
  fwHome: string,
  t: {
    flow: string;
    step: Step;
    item: string;
    cost?: TurnCost | null;
    adapter?: { vendor?: string; model?: string } | null;
    drafts?: string[];
  },
  log: (m: string) => void = () => {},
): void {
  const turn: Turn = {
    at: new Date().toISOString(),
    flow: t.flow,
    step: t.step,
    item: t.item,
    vendor: t.adapter?.vendor ?? null,
    model: t.adapter?.model ?? null,
    tokens_in: n(t.cost?.input_tokens),
    tokens_cached: n(t.cost?.cached_tokens),
    tokens_out: n(t.cost?.output_tokens),
    usd: n(t.cost?.usd),
    drafts: t.drafts ?? [],
  };
  try {
    mkdirSync(join(fwHome, 'meter'), { recursive: true, mode: 0o700 });
    appendFileSync(file(fwHome), `${JSON.stringify(turn)}\n`, { mode: 0o600 });
  } catch (e) {
    log(`meter: could not record a ${t.step} turn of ${t.flow}: ${(e as Error)?.message ?? e}`);
  }
}

/** Every metered turn, oldest first; a torn last line (a crash mid-write) is skipped. */
export function readTurns(fwHome: string): Turn[] {
  if (!existsSync(file(fwHome))) return [];
  const out: Turn[] = [];
  for (const line of readFileSync(file(fwHome), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Turn);
    } catch {
      // skip
    }
  }
  return out;
}

const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** The outcome each draft reached: the Owner's marks, and Frequency's sign-ups for its tag. */
function draftOutcomes(fwHome: string, flow: string): Map<string, Record<Outcome, number>> {
  const { base, home } = flowRef(fwHome, flow);
  const dir = join(home, 'flows', base);
  const signups = new Map<string, number>();
  const raw = readJson(join(dir, 'outcomes.json'));
  for (const r of isObj(raw) && Array.isArray(raw.outcomes) ? raw.outcomes : [])
    if (isObj(r) && typeof r.content === 'string')
      signups.set(r.content, (signups.get(r.content) ?? 0) + n(r.members) + n(r.hosts));
  const out = new Map<string, Record<Outcome, number>>();
  const drafts = join(dir, 'drafts');
  const docs = (existsSync(drafts) ? readdirSync(drafts) : [])
    .map((f) => (f.endsWith('.json') ? readJson(join(drafts, f)) : null))
    .filter((d): d is Record<string, unknown> => isObj(d) && typeof d.id === 'string');
  const marked = (d: Record<string, unknown>) =>
    ['replied_at', 'sent_at', 'declined_at'].some((k) => typeof d[k] === 'string');
  // Long draft ids can share a tag (it is cut at 48 characters), so a tag's sign-ups count once, on a
  // draft the Owner marked when there is one.
  docs.sort((a, b) => Number(marked(b)) - Number(marked(a)) || String(a.id).localeCompare(String(b.id)));
  for (const d of docs) {
    const replied = typeof d.replied_at === 'string';
    const tag = typeof d.tag === 'string' ? d.tag : null;
    const won = tag ? (signups.get(tag) ?? 0) : 0;
    if (tag) signups.delete(tag);
    out.set(d.id as string, {
      drafted: 1,
      sent: marked(d) ? 1 : 0,
      replied: replied ? 1 : 0,
      signed_up: won,
    });
  }
  return out;
}

const zero = (): Record<Outcome, number> => ({ drafted: 0, sent: 0, replied: 0, signed_up: 0 });
const per = (amount: number, count: number) => (count > 0 ? amount / count : null);

export function meterView(fwHome: string, o: { flow: string | null; days: number; now?: Date }) {
  const since = (o.now ?? new Date()).getTime() - o.days * 86_400_000;
  const turns = readTurns(fwHome).filter((t) => (!o.flow || t.flow === o.flow) && Date.parse(t.at) >= since);
  const outcomesByFlow = new Map<string, Map<string, Record<Outcome, number>>>();
  const reached = (t: Turn) => {
    if (!outcomesByFlow.has(t.flow)) outcomesByFlow.set(t.flow, draftOutcomes(fwHome, t.flow));
    const byId = outcomesByFlow.get(t.flow) as Map<string, Record<Outcome, number>>;
    const sum = zero();
    for (const id of t.drafts) {
      const r = byId.get(id) ?? { ...zero(), drafted: 1 };
      for (const k of OUTCOMES) sum[k] += r[k];
    }
    return sum;
  };
  const tok = (t: Turn) => t.tokens_in + t.tokens_cached + t.tokens_out;
  const tokens = { input: 0, cached: 0, output: 0, total: 0 };
  let usd = 0;
  const outcomes = zero();
  const by_step: Record<string, { turns: number; tokens: number; usd: number }> = {};
  const models = new Map<
    string,
    { vendor: string | null; model: string | null; turns: number; tokens: number; usd: number } & Record<
      Outcome,
      number
    >
  >();
  for (const t of turns) {
    const r = reached(t);
    tokens.input += t.tokens_in;
    tokens.cached += t.tokens_cached;
    tokens.output += t.tokens_out;
    tokens.total += tok(t);
    usd += t.usd;
    for (const k of OUTCOMES) outcomes[k] += r[k];
    const s = (by_step[t.step] ??= { turns: 0, tokens: 0, usd: 0 });
    s.turns++;
    s.tokens += tok(t);
    s.usd += t.usd;
    const key = `${t.vendor}\u0000${t.model}`;
    if (!models.has(key))
      models.set(key, { vendor: t.vendor, model: t.model, turns: 0, tokens: 0, usd: 0, ...zero() });
    const m = models.get(key) as NonNullable<ReturnType<typeof models.get>>;
    m.turns++;
    m.tokens += tok(t);
    m.usd += t.usd;
    for (const k of OUTCOMES) m[k] += r[k];
  }
  const packets = turns.map((t) => t.tokens_in + t.tokens_cached).sort((a, b) => a - b);
  return {
    flow: o.flow,
    days: o.days,
    turns: turns.length,
    tokens,
    usd,
    cache_share: tokens.input + tokens.cached > 0 ? tokens.cached / (tokens.input + tokens.cached) : 0,
    packet_p95: packets.length ? packets[Math.max(0, Math.ceil(packets.length * 0.95) - 1)] : 0,
    outcomes,
    per_outcome: Object.fromEntries(
      OUTCOMES.map((k) => [
        k,
        outcomes[k] > 0 ? { tokens: tokens.total / outcomes[k], usd: usd / outcomes[k] } : null,
      ]),
    ),
    by_step,
    by_model: [...models.values()].map((m) => ({
      ...m,
      usd_per_outcome: Object.fromEntries(OUTCOMES.map((k) => [k, per(m.usd, m[k])])),
    })),
  };
}
