// Neighborhood activation flow: pure logic plus the read-only view for GET /v1/flows/{key}. It works one
// large region at a time and routes leads to funnels. It never sends: the Owner does, at L1 (draft only).
// Design: flows/neighborhood-activation/README.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noDashes } from './short-links.ts';

export const FLOW_KEY = 'neighborhood-activation';
const DAY = 86_400_000;

export type LeadKind = 'host' | 'venue' | 'builder' | 'resident';
export type SendVia = 'founder_email' | 'frequency';
export type Stage = 'invite' | 'watch' | 'post_only' | 'capped' | 'blocked' | 'drop';
export type Status = 'active' | 'upkeep' | 'waiting';
export type SubArea = { id: string; name: string; population: number };
type R<T> = Record<string, T>;
type Num<K extends string> = Record<K, number>;
export type Territory = { id: string; name: string; order: number; lat: number; lng: number } & {
  borders: string[];
  placeholder?: boolean;
  sub_areas: SubArea[];
};
export type Activation = Num<'hosts_floor' | 'hosts_per_10k' | 'events_per_host_14d' | 'sub_area_share'> &
  Num<'channels_per_sub_area' | 'wam_per_host' | 'hold_weeks' | 'upkeep_relapse_weeks'>;
export type Funnel = { path: string; persona: string; placeholder?: boolean };
type LeadRules = Num<'fit_threshold' | 'timing_threshold' | 'timing_half_life_days'> &
  Num<'max_touches_per_lead_30d' | 'watch_recheck_days' | 'max_new_invites_per_week'> &
  Partial<Num<'max_touches_per_lead' | 'max_new_contacts_per_day'>>;
/** FW-C-101: a niche with its angles, pain point first. */
export type Niche = { key: string; label: string; angles: { key: string; line: string }[] };
export type FlowConfig = { version: number; seed_territory_id: string; territories: Territory[] } & {
  offer: { name: string; url: string; pitch: string; call_to_action: string };
  engine: { label: string; fallback: string; runs_on: string };
  activation: Activation;
  max_active_sub_areas: number;
  leads: LeadRules;
  funnels: Record<LeadKind, Funnel>;
  send_routes: Record<SendVia, R<unknown>>;
  sources: { key: string; label: string; finds: string; reach: string; action_class: string }[];
} & {
  first_map?: { territory_id: string; sub_areas: string[] };
  niches?: Niche[];
  dm_door?: { path: string; venue_niche?: string };
  hunts?: { sign_off?: string; local_to?: string };
};
const MEASURE_KEYS = ['hosts_active_28d', 'events_next_14d', 'sub_areas_covered_14d', 'wam'] as const;
/** Frequency's numbers for one territory. channels_by_sub_area (optional) feeds the cycle plan. */
export type Measures = Num<(typeof MEASURE_KEYS)[number]> & { channels_by_sub_area?: R<number> };
export type Touch = { at: string; via: SendVia | null };
export type Lead = { id: string; name: string; kind: LeadKind; territory_id: string; url: string } & {
  source: string;
  sub_area?: string;
  channel?: string;
  niche?: string;
  angle?: string;
} & { fit: number; timing: number; timing_at: string; touches: Touch[]; found_at: string; status?: string };
type Counters = { weeks_at_threshold: R<number>; weeks_below: R<number>; awaiting_owner: R<number> };
type Opened = { opened: string[]; metrics: R<Measures>; leads: Lead[]; do_not_contact: string[] };
export type FlowState = Counters & Opened & { spend: { period_start: string; usd: number; turns: number } };
export type Budget = { period: string; max_usd: number | null; max_turns: number | null };

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && !!x && !Array.isArray(x);

export function initialState(now: Date, seed = 'north-county-sd'): FlowState {
  const spend = { period_start: now.toISOString(), usd: 0, turns: 0 };
  const counters: Counters = { weeks_at_threshold: {}, weeks_below: {}, awaiting_owner: {} };
  return { ...counters, opened: [seed], metrics: {}, leads: [], do_not_contact: [], spend };
}

/** Fills defaults and normalises touches: an ISO string becomes {at, via: null}. */
export function parseState(raw: unknown, now: Date, seed?: string): FlowState {
  const s = { ...initialState(now, seed), ...(isObj(raw) ? raw : {}) } as FlowState;
  const leads = Array.isArray(s.leads) ? (s.leads as unknown[]).filter(isObj) : [];
  s.leads = leads.map((l) => {
    const touches = (Array.isArray(l.touches) ? (l.touches as unknown[]) : []).flatMap((t): Touch[] => {
      if (typeof t === 'string') return [{ at: t, via: null }];
      if (!isObj(t) || typeof t.at !== 'string') return [];
      return [{ at: t.at, via: t.via === 'founder_email' || t.via === 'frequency' ? t.via : null }];
    });
    return { ...(l as unknown as Lead), touches };
  });
  return s;
}

export const populationOf = (t: Territory) => t.sub_areas.reduce((a, s) => a + s.population, 0);

/** Targets scale with the region's population; hosts never drop below the floor. */
export function targetsOf(t: Territory, a: Activation): Measures {
  const hosts = Math.max(a.hosts_floor, Math.ceil((populationOf(t) / 10_000) * a.hosts_per_10k));
  const events = Math.ceil(hosts * a.events_per_host_14d);
  const covered = Math.ceil(t.sub_areas.length * a.sub_area_share);
  const wam = Math.ceil(hosts * a.wam_per_host);
  return { hosts_active_28d: hosts, events_next_14d: events, sub_areas_covered_14d: covered, wam };
}

/** Progress is the weakest of the four ratios. No numbers from Frequency reads as unknown (null). */
export function activationOf(t: Territory, m: Measures | undefined, a: Activation) {
  const targets = targetsOf(t, a);
  if (!m || !MEASURE_KEYS.every((k) => Number.isFinite(m[k])))
    return { targets, measures: null, progress: null, qualifies: null };
  const ratios = MEASURE_KEYS.map((k) => (targets[k] > 0 ? Math.min(1, Math.max(0, m[k] / targets[k])) : 1));
  const measures = Object.fromEntries(MEASURE_KEYS.map((k) => [k, m[k]])) as unknown as Measures;
  return { targets, measures, progress: round3(Math.min(...ratios)), qualifies: ratios.every((r) => r >= 1) };
}

/** Last opened is active; earlier opened ones are upkeep unless they slipped long enough to relapse. */
export function statusOf(cfg: FlowConfig, state: FlowState, id: string): Status {
  const i = state.opened.indexOf(id);
  if (i < 0) return 'waiting';
  if (i === state.opened.length - 1) return 'active';
  return (state.weeks_below[id] ?? 0) >= cfg.activation.upkeep_relapse_weeks ? 'active' : 'upkeep';
}

const bordersOf = (cfg: FlowConfig, id: string) =>
  new Set([
    ...(cfg.territories.find((t) => t.id === id)?.borders ?? []),
    ...cfg.territories.filter((t) => t.borders.includes(id)).map((t) => t.id),
  ]);
const hostLeads = (s: FlowState, id: string) =>
  s.leads.filter((l) => l.kind === 'host' && l.territory_id === id).length;

export type Decision =
  | { kind: 'paused_budget' | 'all_active'; summary: string }
  | { kind: 'propose_expansion' | 'keep_working'; territory_id: string; summary: string };
const PERIOD_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };

/** The flow's next move. Expansion is only ever proposed: the Owner opens a territory. */
export function decide(cfg: FlowConfig, state: FlowState, b: Budget, now: Date): Decision {
  const fresh = now.getTime() - ms(state.spend.period_start) < (PERIOD_DAYS[b.period] ?? 7) * DAY;
  const { usd, turns } = fresh ? state.spend : { usd: 0, turns: 0 };
  if ((b.max_usd != null && usd >= b.max_usd) || (b.max_turns != null && turns >= b.max_turns))
    return { kind: 'paused_budget', summary: `Paused: this ${b.period}'s spend cap is used up.` };
  const newest = cfg.territories.find((t) => t.id === state.opened.at(-1)) ?? cfg.territories[0];
  if (!newest) return { kind: 'all_active', summary: 'No territories are configured.' };
  const act = activationOf(newest, state.metrics[newest.id], cfg.activation);
  const weeks = state.weeks_at_threshold[newest.id] ?? 0;
  if (act.qualifies && weeks >= cfg.activation.hold_weeks) {
    const near = new Set(state.opened.flatMap((id) => [...bordersOf(cfg, id)]));
    const byHosts = (x: Territory, y: Territory) => hostLeads(state, y.id) - hostLeads(state, x.id);
    const next = cfg.territories
      .filter((t) => near.has(t.id) && !state.opened.includes(t.id))
      .sort((x, y) => x.order - y.order || byHosts(x, y) || x.name.localeCompare(y.name))[0];
    if (!next) return { kind: 'all_active', summary: 'Every reachable territory is open. Add one to go on.' };
    const summary = `${newest.name} has been fully active for ${weeks} weeks. Open ${next.name} next?`;
    return { kind: 'propose_expansion', territory_id: next.id, summary };
  }
  const pct = act.progress == null ? 'unknown' : `${Math.round(act.progress * 100)}%`;
  const summary = `Working ${newest.name}: ${pct} of the way to fully active, held for ${cfg.activation.hold_weeks} weeks.`;
  return { kind: 'keep_working', territory_id: newest.id, summary };
}

/** The lead's funnel link: persona, region, area, Channel and source, plus utm tags. */
export function funnelOf(cfg: FlowConfig, l: Lead, via: SendVia) {
  const f = cfg.funnels[l.kind];
  const url = new URL(f.path, cfg.offer.url);
  const q = { persona: f.persona, region: l.territory_id, area: l.sub_area, channel: l.channel };
  const utm = { src: l.source, utm_source: 'flowweb', utm_medium: via, utm_campaign: l.territory_id };
  for (const [k, v] of Object.entries({ ...q, ...utm })) if (v) url.searchParams.set(k, v);
  return { path: f.path, persona: f.persona, url: url.toString() };
}

// FW-C-101: the v2 message system. Every draft is built from a niche, an angle and a route.
export type DraftRoute = 'dm' | 'email';
export const SEED_CAMPAIGN = 'creator-seed';
export const WORDS = { dm: 70, follow_up: 40, hard_cap: 120 } as const;
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
export const signOffOf = (cfg: FlowConfig) =>
  cfg.hunts?.sign_off?.trim() || 'Daniel Tyack\nFounder\nfrequencylocal.com';
export const localOf = (cfg: FlowConfig) => cfg.hunts?.local_to?.trim() || 'San Diego (North County)';

/** The lead's niche: venues always use the venue niche; otherwise its own, else "other". */
export function nicheOf(cfg: FlowConfig, l: Pick<Lead, 'kind' | 'niche'>): string {
  if (l.kind === 'venue') return cfg.dm_door?.venue_niche ?? 'venue';
  return slug(l.niche ?? '') || 'other';
}

/** The angle to use: the one asked for when the niche has it, else the niche's first (pain point first). */
export function angleOf(cfg: FlowConfig, niche: string, want?: string | null): string | null {
  const angles = cfg.niches?.find((n) => n.key === niche)?.angles ?? [];
  return angles.find((a) => a.key === want)?.key ?? angles[0]?.key ?? (want ? slug(want) : null);
}

/**
 * The one DM door: /start/host with region, area, Channel, niche and source. No persona. utm_source stays
 * flowweb (short links and Frequency attribution key on it); utm_content is <niche>.<tag>.
 */
export function seedLink(cfg: FlowConfig, l: Lead, route: DraftRoute, tag: string): string {
  const niche = nicheOf(cfg, l);
  const url = new URL(cfg.dm_door?.path ?? cfg.funnels.host.path, cfg.offer.url);
  const q = { region: l.territory_id, area: l.sub_area, channel: l.channel, niche, src: l.source };
  const utm = { utm_source: 'flowweb', utm_medium: route === 'dm' ? 'one-to-one' : 'founder_email' };
  // ref names the draft on its own (FW-C-112), so one draft's link can be learned from apart from its niche.
  const tags = { utm_campaign: SEED_CAMPAIGN, utm_content: `${niche}.${tag}`, ref: tag };
  for (const [k, v] of Object.entries({ ...q, ...utm, ...tags })) if (v) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * A Creator seed draft. A dm has no sign-off and no P.S. and aims for 70 words (40 for a follow-up); an
 * email keeps the Owner's sign-off and a P.S. with the reply-no opt-out. Word limits are warnings; over
 * the hard cap of 120 the draft is marked over_cap and must not be offered as it is.
 */
export function seedDraft(
  cfg: FlowConfig,
  l: Lead,
  o: { route: DraftRoute; tag: string; opener: string; angle?: string | null; follow_up?: boolean },
) {
  const niche = nicheOf(cfg, l);
  const angle = angleOf(cfg, niche, o.angle);
  const link = seedLink(cfg, l, o.route, o.tag);
  const opener = noDashes(o.opener.trim());
  const body =
    o.route === 'dm'
      ? [opener, '', link].join('\n')
      : [
          opener,
          '',
          `If you'd like to host on Frequency, start here: ${link}`,
          '',
          signOffOf(cfg),
          '',
          `P.S. I'm local to ${localOf(cfg)}. If you aren't interested, just reply "no" and I won't reach out again.`,
        ].join('\n');
  const words = wordCount(body);
  const aim = o.route === 'dm' ? (o.follow_up ? WORDS.follow_up : WORDS.dm) : null;
  const warnings: string[] = [];
  if (aim !== null && words > aim)
    warnings.push(`${words} words; a ${o.follow_up ? 'follow-up' : 'DM'} aims for ${aim}.`);
  const over_cap = words > WORDS.hard_cap;
  if (over_cap) warnings.push(`${words} words is over the hard cap of ${WORDS.hard_cap}.`);
  return { lead_id: l.id, niche, angle, route: o.route, tag: o.tag, body, link, words, warnings, over_cap };
}

export type Routed = { lead: Lead; timing: number; stage: Stage; reason: string; send_via: SendVia | null };

/** Routes every lead, in order: blocked, post_only, drop, watch, capped, watch (timing), invite. */
export function routeLeads(cfg: FlowConfig, state: FlowState, now: Date): Routed[] {
  const r = cfg.leads;
  const t = now.getTime();
  const dnc = new Set(state.do_not_contact);
  const out = state.leads.map((lead): Routed => {
    const days = Math.max(0, (t - ms(lead.timing_at)) / DAY) || 0; // timing halves every half-life
    const timing = lead.timing * 0.5 ** (days / r.timing_half_life_days);
    const follow = lead.touches.length > 0;
    const via: SendVia = lead.kind === 'resident' || follow ? 'frequency' : 'founder_email';
    const at = (stage: Stage, reason: string): Routed => {
      const send_via = stage === 'blocked' || stage === 'drop' ? null : via;
      return { lead, timing, stage, reason, send_via };
    };
    if (dnc.has(lead.id) || dnc.has(lead.url)) return at('blocked', 'On the do-not-contact list.');
    if (lead.kind === 'resident') return at('post_only', 'Residents get a post, never a personal message.');
    if (lead.fit < r.fit_threshold) return at('drop', `Fit ${round3(lead.fit)} is below ${r.fit_threshold}.`);
    const status = statusOf(cfg, state, lead.territory_id);
    if (status !== 'active') return at('watch', `Territory is ${status}; only the active one gets outreach.`);
    // FW-C-101: three touches in a lifetime, however long ago; the 30-day cap still holds too.
    const life = r.max_touches_per_lead ?? Number.POSITIVE_INFINITY;
    if (lead.touches.length >= life)
      return at('capped', `Already touched ${life} times; that is the limit for life.`);
    if (lead.touches.filter((x) => t - ms(x.at) < 30 * DAY).length >= r.max_touches_per_lead_30d)
      return at('capped', `Already touched ${r.max_touches_per_lead_30d} times in 30 days.`);
    if (lead.kind === 'host' && timing < r.timing_threshold)
      return at('watch', `Timing ${round3(timing)} is low; check again in ${r.watch_recheck_days} days.`);
    return at('invite', follow ? 'Follow-up to an invite already started.' : 'Ready to invite.');
  });
  // Weekly cap per territory on NEW invites: invites first touched this week count against it.
  const started = new Map<string, number>();
  for (const l of state.leads) {
    const first = Math.min(...l.touches.map((x) => ms(x.at)).filter(Number.isFinite));
    if (Number.isFinite(first) && t - first < 7 * DAY)
      started.set(l.territory_id, (started.get(l.territory_id) ?? 0) + 1);
  }
  const fresh = out.filter((x) => x.stage === 'invite' && x.lead.touches.length === 0);
  for (const x of fresh.sort((a, b) => b.lead.fit * b.timing - a.lead.fit * a.timing)) {
    const n = started.get(x.lead.territory_id) ?? 0;
    if (n < r.max_new_invites_per_week) started.set(x.lead.territory_id, n + 1);
    else Object.assign(x, { stage: 'capped', reason: 'Weekly cap on new invites reached; next week.' });
  }
  return out;
}

/** Sub-areas to work this cycle: active territories only, least covered first (unknown first), then the first map. */
export function planCycle(cfg: FlowConfig, state: FlowState, now: Date) {
  const cov = (id: string, sub: string) => state.metrics[id]?.channels_by_sub_area?.[sub] ?? null;
  const fm = cfg.first_map;
  const firstRank = (t: string, s: string) => {
    const i = fm?.territory_id === t ? fm.sub_areas.indexOf(s) : -1;
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const subs = cfg.territories
    .filter((t) => statusOf(cfg, state, t.id) === 'active')
    .flatMap((t) => t.sub_areas.map((s) => ({ t, s, ch: cov(t.id, s.id) })))
    .filter((x) => x.ch == null || x.ch < cfg.activation.channels_per_sub_area)
    .sort(
      (x, y) =>
        (x.ch ?? -1) - (y.ch ?? -1) ||
        firstRank(x.t.id, x.s.id) - firstRank(y.t.id, y.s.id) ||
        y.s.population - x.s.population,
    )
    .slice(0, Math.max(0, cfg.max_active_sub_areas))
    .map(({ t, s, ch }) => {
      const reason = ch == null ? 'Channel coverage unknown' : `${ch} of 7 Channels in the next 14 days`;
      return { territory_id: t.id, sub_area: s.id, reason };
    });
  const invites = routeLeads(cfg, state, now).filter((x) => x.stage === 'invite');
  return { sub_areas: subs, invites: invites.map((x) => x.lead.id) };
}

export const CYCLE_STEPS = [
  { key: 'find', label: 'Find hosts, venues, builders and residents from each source', outward: false },
  { key: 'score', label: 'Score fit and timing', outward: false },
  { key: 'route', label: 'Route each lead to a funnel and a send route', outward: false },
  { key: 'draft', label: 'Draft invites and posts', outward: false },
  { key: 'owner_approval', label: 'You approve, edit or reject each item', outward: false },
  { key: 'send', label: 'You send it from your email or through Frequency', outward: true },
  { key: 'measure', label: 'Read hosts, events and weekly members from Frequency', outward: false },
] as const;

/** The view GET /v1/flows/neighborhood-activation returns. */
export function flowView(cfg: FlowConfig, state: FlowState, b: Budget, stream: R<unknown>, now: Date) {
  const routed = routeLeads(cfg, state, now);
  const territories = [...cfg.territories]
    .sort((x, y) => x.order - y.order)
    .map((t) => {
      const leads = { host: 0, venue: 0, builder: 0, resident: 0 };
      for (const l of state.leads) if (l.territory_id === t.id && l.kind in leads) leads[l.kind]++;
      const { id, name, order, sub_areas } = t;
      const head = { id, name, order, status: statusOf(cfg, state, id), borders: [...bordersOf(cfg, id)] };
      const act = activationOf(t, state.metrics[id], cfg.activation);
      const w = state.weeks_at_threshold[id] ?? 0;
      const weeks = { weeks_at_threshold: w, weeks_below: state.weeks_below[id] ?? 0 };
      return { ...head, population: populationOf(t), sub_areas, ...act, ...weeks, leads };
    });
  const pipeline = { invite: 0, watch: 0, post_only: 0, capped: 0, blocked: 0, drop: 0 };
  for (const x of routed) pipeline[x.stage]++;
  const funnels = Object.entries(cfg.funnels) as [LeadKind, Funnel][];
  const placeholders = [
    ...funnels.filter(([, f]) => f.placeholder).map(([k]) => `${k}_funnel`),
    ...cfg.territories.filter((t) => t.placeholder).map((t) => t.id.replaceAll('-', '_')),
  ];
  const leads = routed.map(({ lead: l, timing, stage, reason, send_via }) => {
    const { id, name, kind, territory_id, source, url, fit, touches } = l;
    const where = { sub_area: l.sub_area ?? null, channel: l.channel ?? null };
    const funnel = send_via ? funnelOf(cfg, l, send_via) : null;
    const scored = { source, url, fit, timing: round3(timing), touches };
    return { id, name, kind, territory_id, ...where, ...scored, stage, reason, send_via, funnel };
  });
  const { spend } = state;
  const gate_on = (stream.human_gate as { gate_on?: string[] } | undefined)?.gate_on ?? [];
  const name = String(stream.name ?? 'Neighborhood activation');
  const head = {
    key: FLOW_KEY,
    name,
    enabled: stream.enabled === true,
    tier: String(stream.default_tier ?? 'L1'),
  };
  const { offer, engine, sources, send_routes } = cfg;
  const defs = { gate_on, offer, engine, sources, funnels: cfg.funnels };
  const where = { send_routes, placeholders, thresholds: cfg.activation, opened: state.opened, territories };
  const next = { decision: decide(cfg, state, b, now), plan: planCycle(cfg, state, now), steps: CYCLE_STEPS };
  const budget = { ...b, spent_usd: spend.usd, used_turns: spend.turns, since: spend.period_start };
  const awaiting_owner_total = Object.values(state.awaiting_owner).reduce((a, n) => a + n, 0);
  return { ...head, ...defs, ...where, leads, pipeline, ...next, budget, awaiting_owner_total };
}

/** Reads the flow: the definition from the repo, config.json overridable and state.json from $FW_HOME. */
export function loadFlow(repoRoot: string, fwHome: string, now = new Date()) {
  const repoDir = join(repoRoot, 'flows', FLOW_KEY);
  const homeDir = join(fwHome, 'flows', FLOW_KEY);
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as unknown;
  if (!existsSync(join(repoDir, 'stream.json'))) return null;
  const override = join(homeDir, 'config.json');
  const configPath = existsSync(override) ? override : join(repoDir, 'config.json');
  const stream = readJson(join(repoDir, 'stream.json')) as R<unknown>;
  const cfg = readJson(configPath) as FlowConfig;
  const path = join(homeDir, 'state.json');
  const statePath = existsSync(path) ? path : null;
  const state = parseState(statePath ? readJson(statePath) : null, now, cfg.seed_territory_id);
  const sb = (stream.budget ?? {}) as { period?: string; caps?: { max_usd?: number; max_turns?: number } };
  const { max_usd = null, max_turns = null } = sb.caps ?? {};
  const budget: Budget = { period: sb.period ?? 'week', max_usd, max_turns };
  return { stream, cfg, state, budget, configPath, statePath };
}
