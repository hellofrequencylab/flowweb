// Local saturation marketing flow: pure decision logic plus a read-only view for GET /v1/flows/{key}.
// It decides which areas to work, how saturated each one is, and when the next ring opens. It never
// publishes or sends: every outward item is a draft that waits for the Owner (core-policy denies
// publish_external and outbound_email_external, and the stream runs at L1, draft only).
// Design: flows/local-saturation/README.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FLOW_KEY = 'local-saturation';

export interface Area {
  id: string;
  name: string;
  lat: number;
  lng: number;
  population: number;
}

export interface Channel {
  key: string;
  label: string;
  action_class: string;
  placeholder?: boolean;
}

export interface FlowConfig {
  version: number;
  offer: { name: string; url: string; pitch: string; call_to_action: string; placeholder?: boolean };
  engine: { label: string; fallback: string; runs_on: string };
  seed_area_id: string;
  seed_is_placeholder?: boolean;
  ring_width_km: number;
  saturation: {
    threshold: number;
    hold_cycles: number;
    weights: { coverage: number; cadence: number; response: number };
    touches_per_target_28d: number;
    new_members_per_10k_28d: number;
  };
  max_active_areas: number;
  channels: Channel[];
  areas: Area[];
}

/** What the last 28 days look like in one area. Written by fwd after each cycle. */
export interface AreaSignals {
  /** Places, groups and people worth reaching that research has found. */
  targets_known: number;
  /** Of those, how many have had at least one approved, posted touch. */
  targets_reached: number;
  /** Approved, posted touches in the last 28 days. */
  touches_28d: number;
  /** New members whose Circle meets in this area, last 28 days. */
  new_members_28d: number;
}

export interface FlowState {
  /** Highest ring the Owner has opened. Ring 0 (the seed) is open from the start. */
  open_ring: number;
  /** Consecutive finished cycles in which the open ring averaged at or above the threshold. */
  cycles_at_threshold: number;
  signals: Record<string, AreaSignals>;
  spend: { period_start: string; usd: number; turns: number };
  /** Drafts waiting for the Owner, by area. */
  awaiting_owner: Record<string, number>;
}

export interface Budget {
  period: string;
  max_usd: number | null;
  max_turns: number | null;
}

export const EMPTY_SIGNALS: AreaSignals = {
  targets_known: 0,
  targets_reached: 0,
  touches_28d: 0,
  new_members_28d: 0,
};

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Great-circle distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Rings around the seed. Ring 0 is the seed alone; the rest are distance bands of ring_width_km,
 * renumbered 1, 2, 3 in order so an empty band never stalls expansion.
 */
export function ringsOf(cfg: FlowConfig): { ring: number; areas: (Area & { km: number })[] }[] {
  const seed = cfg.areas.find((a) => a.id === cfg.seed_area_id);
  if (!seed) throw new Error(`seed area ${cfg.seed_area_id} is not in the area list`);
  if (!(cfg.ring_width_km > 0)) throw new Error('ring_width_km must be above zero');
  const bands = new Map<number, (Area & { km: number })[]>();
  for (const a of cfg.areas) {
    const km = distanceKm(seed, a);
    const band = a.id === seed.id ? 0 : Math.max(1, Math.floor(km / cfg.ring_width_km));
    const list = bands.get(band) ?? [];
    list.push({ ...a, km: Math.round(km * 10) / 10 });
    bands.set(band, list);
  }
  return [...bands.keys()]
    .sort((x, y) => x - y)
    .map((band, i) => ({ ring: i, areas: (bands.get(band) ?? []).sort((x, y) => x.km - y.km) }));
}

/**
 * Saturation of one area, 0 to 1. Coverage: share of known targets reached. Cadence: touches
 * against the wanted rate per reached target. Response: new members against the target per 10k
 * residents. An area with no research yet scores 0.
 */
export function saturationOf(
  s: AreaSignals,
  population: number,
  cfg: FlowConfig['saturation'],
): { score: number; coverage: number; cadence: number; response: number } {
  const coverage = s.targets_known > 0 ? clamp01(s.targets_reached / s.targets_known) : 0;
  const wanted = s.targets_reached * cfg.touches_per_target_28d;
  const cadence = wanted > 0 ? clamp01(s.touches_28d / wanted) : 0;
  const goal = (Math.max(population, 0) / 10_000) * cfg.new_members_per_10k_28d;
  const response = goal > 0 ? clamp01(s.new_members_28d / goal) : 0;
  const w = cfg.weights;
  const total = w.coverage + w.cadence + w.response;
  const score = total > 0 ? (w.coverage * coverage + w.cadence * cadence + w.response * response) / total : 0;
  return {
    score: round3(score),
    coverage: round3(coverage),
    cadence: round3(cadence),
    response: round3(response),
  };
}

export type Decision =
  | { kind: 'paused_budget'; summary: string }
  | { kind: 'propose_expansion'; ring: number; area_ids: string[]; summary: string }
  | { kind: 'keep_working'; summary: string }
  | { kind: 'all_saturated'; summary: string };

export function budgetLeft(state: FlowState, b: Budget): { usd: number | null; turns: number | null } {
  return {
    usd: b.max_usd == null ? null : round3(b.max_usd - state.spend.usd),
    turns: b.max_turns == null ? null : b.max_turns - state.spend.turns,
  };
}

/** The flow's next move. Expansion is only ever proposed: the Owner opens a ring. */
export function decide(cfg: FlowConfig, state: FlowState, b: Budget): Decision {
  const left = budgetLeft(state, b);
  if ((left.usd != null && left.usd <= 0) || (left.turns != null && left.turns <= 0))
    return { kind: 'paused_budget', summary: `Paused: this ${b.period}'s spend cap is used up.` };
  const rings = ringsOf(cfg);
  const open = rings.filter((r) => r.ring <= state.open_ring);
  const avg = ringAverage(cfg, state, open.at(-1)?.areas ?? []);
  const next = rings.find((r) => r.ring === state.open_ring + 1);
  const ready = avg >= cfg.saturation.threshold && state.cycles_at_threshold >= cfg.saturation.hold_cycles;
  if (ready && next)
    return {
      kind: 'propose_expansion',
      ring: next.ring,
      area_ids: next.areas.map((a) => a.id),
      summary: `Ring ${state.open_ring} has held ${Math.round(avg * 100)}% for ${state.cycles_at_threshold} cycles. Open ring ${next.ring} (${next.areas.map((a) => a.name).join(', ')})?`,
    };
  if (ready)
    return {
      kind: 'all_saturated',
      summary: 'Every ring is saturated. Add areas further out to keep going.',
    };
  return {
    kind: 'keep_working',
    summary: `Working ring ${state.open_ring}: ${Math.round(avg * 100)}% saturated, opens the next ring at ${Math.round(cfg.saturation.threshold * 100)}% held for ${cfg.saturation.hold_cycles} cycles.`,
  };
}

function ringAverage(cfg: FlowConfig, state: FlowState, areas: Area[]): number {
  if (areas.length === 0) return 0;
  const sum = areas.reduce(
    (a, x) => a + saturationOf(state.signals[x.id] ?? EMPTY_SIGNALS, x.population, cfg.saturation).score,
    0,
  );
  return round3(sum / areas.length);
}

export const CYCLE_STEPS = [
  { key: 'research', label: 'Find places, groups and people worth reaching', outward: false },
  { key: 'draft', label: 'Draft posts and messages for each channel', outward: false },
  { key: 'review', label: 'Second model checks voice, facts and links', outward: false },
  { key: 'owner_approval', label: 'You approve, edit or reject each item', outward: false },
  { key: 'handoff', label: 'You post or send it, then mark it done', outward: true },
] as const;

/** Areas to work this cycle: open rings only, least saturated first, at most max_active_areas. */
export function planCycle(cfg: FlowConfig, state: FlowState): { area_id: string; reason: string }[] {
  const open = ringsOf(cfg)
    .filter((r) => r.ring <= state.open_ring)
    .flatMap((r) => r.areas);
  return open
    .map((a) => ({
      a,
      s: saturationOf(state.signals[a.id] ?? EMPTY_SIGNALS, a.population, cfg.saturation).score,
    }))
    .filter((x) => x.s < cfg.saturation.threshold)
    .sort((x, y) => x.s - y.s || x.a.km - y.a.km)
    .slice(0, Math.max(0, cfg.max_active_areas))
    .map((x) => ({ area_id: x.a.id, reason: `${Math.round(x.s * 100)}% saturated` }));
}

export function initialState(now: Date): FlowState {
  return {
    open_ring: 0,
    cycles_at_threshold: 0,
    signals: {},
    spend: { period_start: now.toISOString(), usd: 0, turns: 0 },
    awaiting_owner: {},
  };
}

/** The view GET /v1/flows/local-saturation returns. */
export function flowView(cfg: FlowConfig, state: FlowState, b: Budget, stream: Record<string, unknown>) {
  const rings = ringsOf(cfg).map((r) => ({
    ring: r.ring,
    open: r.ring <= state.open_ring,
    average: ringAverage(cfg, state, r.areas),
    areas: r.areas.map((a) => {
      const s = state.signals[a.id] ?? EMPTY_SIGNALS;
      return {
        id: a.id,
        name: a.name,
        km_from_seed: a.km,
        population: a.population,
        saturation: saturationOf(s, a.population, cfg.saturation),
        signals: s,
        awaiting_owner: state.awaiting_owner[a.id] ?? 0,
      };
    }),
  }));
  const placeholders: string[] = [];
  if (cfg.offer.placeholder) placeholders.push('offer');
  if (cfg.seed_is_placeholder) placeholders.push('starting_area');
  if (cfg.channels.some((c) => c.placeholder)) placeholders.push('channels');
  return {
    key: FLOW_KEY,
    name: String(stream.name ?? 'Local saturation marketing'),
    enabled: stream.enabled === true,
    tier: String(stream.default_tier ?? 'L1'),
    gate_on: ((stream.human_gate as { gate_on?: string[] } | undefined)?.gate_on ?? []) as string[],
    offer: cfg.offer,
    engine: cfg.engine,
    channels: cfg.channels,
    placeholders,
    thresholds: {
      ...cfg.saturation,
      max_active_areas: cfg.max_active_areas,
      ring_width_km: cfg.ring_width_km,
    },
    open_ring: state.open_ring,
    cycles_at_threshold: state.cycles_at_threshold,
    rings,
    decision: decide(cfg, state, b),
    plan: planCycle(cfg, state),
    steps: CYCLE_STEPS,
    budget: {
      ...b,
      spent_usd: state.spend.usd,
      used_turns: state.spend.turns,
      since: state.spend.period_start,
    },
    awaiting_owner_total: Object.values(state.awaiting_owner).reduce((a, n) => a + n, 0),
  };
}

/**
 * Reads the flow from disk. The definition ships in the repo (flows/local-saturation/); the Owner
 * may override config.json in $FW_HOME/flows/local-saturation/, where fwd also keeps state.json.
 */
export function loadFlow(repoRoot: string, fwHome: string, now = new Date()) {
  const repoDir = join(repoRoot, 'flows', FLOW_KEY);
  const homeDir = join(fwHome, 'flows', FLOW_KEY);
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as unknown;
  const cfgPath = existsSync(join(homeDir, 'config.json'))
    ? join(homeDir, 'config.json')
    : join(repoDir, 'config.json');
  if (!existsSync(join(repoDir, 'stream.json'))) return null;
  const stream = readJson(join(repoDir, 'stream.json')) as Record<string, unknown>;
  const cfg = readJson(cfgPath) as FlowConfig;
  const statePath = join(homeDir, 'state.json');
  const state = existsSync(statePath)
    ? { ...initialState(now), ...(readJson(statePath) as Partial<FlowState>) }
    : initialState(now);
  const caps = ((stream.budget as { caps?: { max_usd?: number; max_turns?: number } } | undefined)?.caps ??
    {}) as { max_usd?: number; max_turns?: number };
  const budget: Budget = {
    period: String((stream.budget as { period?: string } | undefined)?.period ?? 'week'),
    max_usd: caps.max_usd ?? null,
    max_turns: caps.max_turns ?? null,
  };
  return {
    stream,
    cfg,
    state,
    budget,
    configPath: cfgPath,
    statePath: existsSync(statePath) ? statePath : null,
  };
}
