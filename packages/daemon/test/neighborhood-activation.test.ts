// Neighborhood activation flow: targets, progress, status, expansion, lead routing, funnels, send
// routes, budget pause and the shipped definition. The flow only ever drafts and proposes.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validate } from '@fw/contracts';
import { describe, expect, test } from 'vitest';
import type { Budget, FlowConfig, FlowState, Lead, Measures } from '../src/flows/neighborhood-activation.ts';
import * as na from '../src/flows/neighborhood-activation.ts';
import { tempHome } from './api-fixtures.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const cfgPath = join(repoRoot, 'flows/neighborhood-activation/config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as FlowConfig;
const now = new Date('2026-11-10T12:00:00Z');
const budget: Budget = { period: 'week', max_usd: 5, max_turns: 200 };
const [SEED, OC] = ['north-county-sd', 'orange-county'];
const ter = (id: string) => cfg.territories.find((x) => x.id === id) ?? cfg.territories[0]!;
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const met: Measures = { hosts_active_28d: 1e6, events_next_14d: 1e6, sub_areas_covered_14d: 99, wam: 1e9 };
const state = (extra: Partial<FlowState> = {}): FlowState => ({ ...na.initialState(now), ...extra });
const decide = (s: FlowState, c = cfg) => na.decide(c, s, budget, now);
const lead = (over: Partial<Lead> = {}): Lead => ({
  ...{ id: 'l1', name: 'Lead', kind: 'host', territory_id: SEED, source: 'event_listings', url: 'u:l1' },
  ...{ fit: 0.9, timing: 0.9, timing_at: ago(0), touches: [], found_at: ago(1), ...over },
});
const route = (s: FlowState) => Object.fromEntries(na.routeLeads(cfg, s, now).map((r) => [r.lead.id, r]));
const view = (s: FlowState) => na.flowView(cfg, s, budget, {}, now);

describe('activation and expansion', () => {
  const act = (m?: Measures) => na.activationOf(ter(SEED), m, cfg.activation);

  test('targets scale with population, with a floor of 100 hosts', () => {
    const nc = { hosts_active_28d: 100, events_next_14d: 100, sub_areas_covered_14d: 8, wam: 1000 };
    expect(na.targetsOf(ter(SEED), cfg.activation)).toEqual(nc);
    expect(na.targetsOf(ter(OC), cfg.activation).hosts_active_28d).toBe(223);
  });

  test('no numbers from Frequency read as unknown, not zero, and progress is the weakest ratio', () => {
    const unknown = { measures: null, progress: null, qualifies: null };
    expect(act()).toMatchObject(unknown);
    expect(act({ hosts_active_28d: 5 } as Measures)).toMatchObject(unknown);
    const half = { hosts_active_28d: 100, events_next_14d: 50, sub_areas_covered_14d: 8, wam: 2000 };
    expect(act(half)).toMatchObject({ progress: 0.5, qualifies: false });
    expect(act(met)).toMatchObject({ progress: 1, qualifies: true });
  });

  test('the newest opened is active, earlier ones upkeep until they relapse, the rest wait', () => {
    const s = state({ opened: [SEED, OC] });
    const st = () => ['san-diego', SEED, OC].map((id) => na.statusOf(cfg, s, id));
    expect(st()).toEqual(['waiting', 'upkeep', 'active']);
    s.weeks_below = { [SEED]: cfg.activation.upkeep_relapse_weeks };
    expect(st()).toEqual(['waiting', 'active', 'active']);
  });

  test('expansion waits for the hold weeks, proposes the first bordering territory, and opens nothing', () => {
    expect(decide(state()).kind).toBe('keep_working');
    const s = state({ metrics: { [SEED]: met }, weeks_at_threshold: { [SEED]: 3 } });
    expect(decide(s).kind).toBe('keep_working');
    s.weeks_at_threshold = { [SEED]: 4 };
    expect(decide(s)).toMatchObject({ kind: 'propose_expansion', territory_id: OC });
    view(s);
    expect(s.opened).toEqual([SEED]);
  });

  test('borders count both ways, and a territory bordering no opened one is never picked', () => {
    const opened = [SEED, OC, 'inland-north'];
    const s = state({ opened, metrics: { 'inland-north': met }, weeks_at_threshold: { 'inland-north': 4 } });
    expect(decide(s)).toMatchObject({ territory_id: 'san-diego' });
    const lonely = { ...cfg, territories: cfg.territories.map((t) => ({ ...t, borders: [] })) };
    const s2 = state({ metrics: { [SEED]: met }, weeks_at_threshold: { [SEED]: 4 } });
    expect(decide(s2, lonely).kind).toBe('all_active');
  });

  test('a used-up dollar or turn cap pauses first; last period spend does not', () => {
    const s = state({ metrics: { [SEED]: met }, weeks_at_threshold: { [SEED]: 9 } });
    s.spend = { period_start: now.toISOString(), usd: 5, turns: 0 };
    expect(decide(s).kind).toBe('paused_budget');
    s.spend = { period_start: now.toISOString(), usd: 0, turns: 200 };
    expect(decide(s).kind).toBe('paused_budget');
    s.spend = { period_start: ago(8), usd: 5, turns: 200 };
    expect(decide(s).kind).toBe('propose_expansion');
  });
});

describe('lead routing', () => {
  test('every branch, in order, and timing halves every half-life', () => {
    const leads = [
      lead({ id: 'l-dnc', kind: 'resident' }),
      lead({ id: 'l-urldnc', url: 'u:dnc' }),
      lead({ id: 'l-res', kind: 'resident', fit: 0.1 }),
      lead({ id: 'l-low', fit: 0.5 }),
      lead({ id: 'l-far', territory_id: OC }),
      lead({ id: 'l-cap', kind: 'venue', touches: [9, 18, 27].map((d) => ({ at: ago(d), via: null })) }),
      lead({ id: 'l-late', timing_at: ago(28) }),
      lead({ id: 'l-venue', kind: 'venue', timing: 0.1 }),
      lead({ id: 'l-ok' }),
    ];
    const r = na.routeLeads(cfg, state({ do_not_contact: ['l-dnc', 'u:dnc'], leads }), now);
    const want = 'blocked blocked post_only drop watch capped watch invite invite';
    expect(r.map((x) => x.stage)).toEqual(want.split(' '));
    expect(r[4]?.reason).toMatch(/waiting/);
    expect(route(state({ opened: [SEED, OC], leads: [lead()] })).l1?.reason).toMatch(/upkeep/);
    const half = route(state({ leads: [lead({ timing: 0.8, timing_at: ago(14) })] })).l1;
    expect(half).toMatchObject({ timing: expect.closeTo(0.4, 6), stage: 'watch' });
  });

  test('new invites stop at the weekly cap per territory, best fit times timing first', () => {
    const started = Array.from({ length: cfg.leads.max_new_invites_per_week - 1 }, (_, i) =>
      lead({ id: `s${i}`, touches: [{ at: ago(2), via: 'founder_email' }] }),
    );
    const leads = [...started, lead({ id: 'weak', fit: 0.7 }), lead({ id: 'strong', fit: 1 })];
    const r = route(state({ leads }));
    expect(r.strong?.stage).toBe('invite');
    expect(r.weak).toMatchObject({ stage: 'capped', reason: expect.stringMatching(/next week/) });
    expect(r.s0).toMatchObject({ stage: 'invite', send_via: 'frequency' });
  });

  test('funnel links carry persona, region, area, channel, source and utm tags', () => {
    const v = view(state({ leads: [lead({ sub_area: 'encinitas', channel: 'movement' })] })).leads[0];
    const url = new URL(v?.funnel?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://frequencylocal.com/start/host');
    const q = `persona=practitioner&region=${SEED}&area=encinitas&channel=movement&src=event_listings`;
    expect(url.search).toBe(`?${q}&utm_source=flowweb&utm_medium=founder_email&utm_campaign=${SEED}`);
  });

  test('personal invites go by founder email, residents by Frequency, drop and blocked nowhere', () => {
    const kinds = [lead({ id: 'v', kind: 'venue' }), lead({ id: 'bu', kind: 'builder' })];
    const rest = [lead({ id: 'r', kind: 'resident' }), lead({ id: 'd', fit: 0 }), lead({ id: 'b' })];
    const s = state({ do_not_contact: ['b'], leads: [...kinds, ...rest] });
    const v = Object.fromEntries(view(s).leads.map((l) => [l.id, l]));
    expect(v.v).toMatchObject({ send_via: 'founder_email', funnel: { persona: 'partner' } });
    expect(v.bu).toMatchObject({ send_via: 'founder_email', funnel: { path: '/start/welcome' } });
    expect(v.r).toMatchObject({ send_via: 'frequency', funnel: { path: '/start/event' } });
    expect(v.d).toMatchObject({ send_via: null, funnel: null });
    expect(v.b).toMatchObject({ send_via: null, funnel: null });
  });

  test('touches may be plain ISO strings or {at, via}, and come out normalised', () => {
    const raw = { leads: [{ ...lead(), touches: [ago(1), { at: ago(2), via: 'frequency' }, 7] }] };
    const s = na.parseState(raw, now);
    const want = [
      { at: ago(1), via: null },
      { at: ago(2), via: 'frequency' },
    ];
    expect(s.leads[0]?.touches).toEqual(want);
    expect(s.opened).toEqual([SEED]);
    expect(view(s).leads[0]?.touches).toHaveLength(2);
  });
});

describe('plan and shipped definition', () => {
  test('the plan works active sub-areas, unknown first, at most max_active_sub_areas', () => {
    const channels = Object.fromEntries(ter(SEED).sub_areas.map((s) => [s.id, s.id === 'poway' ? 0 : 2]));
    const s = state({ metrics: { [SEED]: { ...met, channels_by_sub_area: channels } } });
    const p = na.planCycle(cfg, s, now);
    expect(p.sub_areas).toHaveLength(cfg.max_active_sub_areas);
    expect(p.sub_areas[0]?.sub_area).toBe('poway');
    expect(na.planCycle(cfg, state(), now).sub_areas[0]?.reason).toMatch(/unknown/);
  });

  test('loads from the repo, validates, ships disabled at L1 and gates every source on the Owner', () => {
    const home = tempHome();
    try {
      const f = na.loadFlow(repoRoot, home.path, now);
      if (!f) throw new Error('flow did not load');
      expect(validate('stream-definition', f.stream).errors).toEqual([]);
      expect(f.stream).toMatchObject({ enabled: false, default_tier: 'L1' });
      const gate = f.stream.human_gate as { approver: string; gate_on: string[] };
      expect(gate.approver).toBe('owner');
      const outward = f.cfg.sources.filter((s) => s.action_class !== 'read_research');
      for (const s of outward) expect(gate.gate_on).toContain(s.action_class);
      expect(f.budget).toEqual(budget);
      const v = na.flowView(f.cfg, f.state, f.budget, f.stream, now);
      expect(v.placeholders).toEqual(['host_funnel']);
      expect(v.territories.map((t) => t.status)).toEqual(['active', 'waiting', 'waiting', 'waiting']);
      expect(v.steps.filter((s) => s.outward).map((s) => s.key)).toEqual(['send']);
    } finally {
      home.cleanup();
    }
  });
});
