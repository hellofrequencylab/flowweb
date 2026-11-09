// Local saturation marketing flow: rings, saturation, expansion, budget pause, and the shipped
// definition. The flow only ever drafts; the tests also pin that the outward actions stay gated.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  type AreaSignals,
  type Budget,
  decide,
  type FlowConfig,
  type FlowState,
  flowView,
  initialState,
  loadFlow,
  planCycle,
  ringsOf,
  saturationOf,
} from '../src/flows/local-saturation.ts';
import { tempHome } from './api-fixtures.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const shipped = JSON.parse(
  readFileSync(join(repoRoot, 'flows/local-saturation/config.json'), 'utf8'),
) as FlowConfig;
const now = new Date('2026-11-09T12:00:00Z');
const budget: Budget = { period: 'week', max_usd: 5, max_turns: 200 };

const full: AreaSignals = { targets_known: 20, targets_reached: 20, touches_28d: 40, new_members_28d: 1000 };

function stateWith(signals: Record<string, AreaSignals>, extra: Partial<FlowState> = {}): FlowState {
  return { ...initialState(now), signals, ...extra };
}

describe('rings', () => {
  test('ring 0 is the seed alone, and rings grow outward with no gaps', () => {
    const rings = ringsOf(shipped);
    expect(rings[0]?.areas.map((a) => a.id)).toEqual([shipped.seed_area_id]);
    expect(rings.map((r) => r.ring)).toEqual(rings.map((_, i) => i));
    const ring1 = rings[1]?.areas ?? [];
    const ring2 = rings[2]?.areas ?? [];
    expect(Math.max(...ring1.map((a) => a.km))).toBeLessThan(Math.min(...ring2.map((a) => a.km)));
    expect(rings.flatMap((r) => r.areas).length).toBe(shipped.areas.length);
  });

  test('an unknown seed is an error, not a silent empty flow', () => {
    expect(() => ringsOf({ ...shipped, seed_area_id: 'nowhere' })).toThrow(/seed area/);
  });
});

describe('saturation', () => {
  test('no research yet scores zero', () => {
    expect(
      saturationOf(
        { targets_known: 0, targets_reached: 0, touches_28d: 0, new_members_28d: 0 },
        1000,
        shipped.saturation,
      ).score,
    ).toBe(0);
  });

  test('each part is capped at 1, and full marks score 1', () => {
    const s = saturationOf(full, 10_000, shipped.saturation);
    expect(s).toEqual({ score: 1, coverage: 1, cadence: 1, response: 1 });
  });

  test('half coverage, full cadence, no members gives the weighted blend', () => {
    const s = saturationOf(
      { targets_known: 10, targets_reached: 5, touches_28d: 10, new_members_28d: 0 },
      10_000,
      shipped.saturation,
    );
    expect(s.coverage).toBe(0.5);
    expect(s.cadence).toBe(1);
    expect(s.response).toBe(0);
    expect(s.score).toBe(0.5);
  });
});

describe('decide', () => {
  test('a new flow works the seed and does not expand', () => {
    const d = decide(shipped, initialState(now), budget);
    expect(d.kind).toBe('keep_working');
    expect(planCycle(shipped, initialState(now))).toEqual([
      { area_id: shipped.seed_area_id, reason: '0% saturated' },
    ]);
  });

  test('a saturated ring proposes the next ring only after the hold cycles', () => {
    const seed = shipped.seed_area_id;
    expect(decide(shipped, stateWith({ [seed]: full }, { cycles_at_threshold: 1 }), budget).kind).toBe(
      'keep_working',
    );
    const d = decide(shipped, stateWith({ [seed]: full }, { cycles_at_threshold: 2 }), budget);
    expect(d.kind).toBe('propose_expansion');
    if (d.kind === 'propose_expansion') {
      expect(d.ring).toBe(1);
      expect(d.area_ids).toEqual(ringsOf(shipped)[1]?.areas.map((a) => a.id));
    }
  });

  test('expansion is a proposal: the open ring does not move by itself', () => {
    const s = stateWith({ [shipped.seed_area_id]: full }, { cycles_at_threshold: 5 });
    flowView(shipped, s, budget, {});
    expect(s.open_ring).toBe(0);
  });

  test('the outermost ring saturated means all saturated', () => {
    const last = ringsOf(shipped).length - 1;
    const signals = Object.fromEntries(shipped.areas.map((a) => [a.id, full]));
    expect(
      decide(shipped, stateWith(signals, { open_ring: last, cycles_at_threshold: 2 }), budget).kind,
    ).toBe('all_saturated');
  });

  test('a used-up cap pauses the flow before anything else', () => {
    const s = stateWith({ [shipped.seed_area_id]: full }, { cycles_at_threshold: 9 });
    s.spend = { period_start: now.toISOString(), usd: 5, turns: 0 };
    expect(decide(shipped, s, budget).kind).toBe('paused_budget');
    s.spend = { period_start: now.toISOString(), usd: 0, turns: 200 };
    expect(decide(shipped, s, budget).kind).toBe('paused_budget');
  });

  test('the plan never names more areas than max_active_areas, least saturated first', () => {
    const last = ringsOf(shipped).length - 1;
    const plan = planCycle({ ...shipped, max_active_areas: 3 }, stateWith({}, { open_ring: last }));
    expect(plan).toHaveLength(3);
    expect(plan[0]?.area_id).toBe(shipped.seed_area_id);
  });
});

describe('shipped definition', () => {
  test('loads from the repo, starts disabled at draft tier, and gates every outward action on the Owner', () => {
    const home = tempHome();
    try {
      const f = loadFlow(repoRoot, home.path, now);
      expect(f).not.toBeNull();
      if (!f) return;
      expect(f.stream.enabled).toBe(false);
      expect(f.stream.default_tier).toBe('L1');
      const gate = (f.stream.human_gate as { approver: string; gate_on: string[] }) ?? {};
      expect(gate.approver).toBe('owner');
      for (const c of f.cfg.channels) expect(gate.gate_on).toContain(c.action_class);
      expect(f.budget).toEqual({ period: 'week', max_usd: 5, max_turns: 200 });
      const v = flowView(f.cfg, f.state, f.budget, f.stream);
      expect(v.placeholders).toEqual(['offer', 'starting_area', 'channels']);
      expect(v.steps.filter((s) => s.outward).map((s) => s.key)).toEqual(['handoff']);
    } finally {
      home.cleanup();
    }
  });
});
