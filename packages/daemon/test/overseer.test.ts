// FW-C-033: the Supervisor's gates (pure) and its Owner controls (settings plus one event each).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ASK_CAP,
  capUsed,
  createSupervisorOnFire,
  DRY_STOP,
  decide,
  type FlowFacts,
  GATES,
  plan,
  readSettings,
  STALL_STOP,
  SupervisorError,
  type SupervisorFacts,
  setDial,
  setFlowEnabled,
  setPaused,
  shippedFlows,
  supervisorView,
} from '../src/overseer/index.ts';
import { tempHome, withWriter } from './api-fixtures.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');

const flow = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  key: 'f',
  enabled: true,
  has_engine: true,
  dial: 'draft',
  dial_confirmed: false,
  caps: { max_usd: 5, max_turns: 200, period: 'week' },
  spend: { usd: 0, turns: 0 },
  open_asks: 0,
  dry_streak: 0,
  stall_streak: 0,
  running: 0,
  wip_limit: 1,
  due: true,
  ...over,
});
const sup = (over: Partial<SupervisorFacts> = {}): SupervisorFacts => ({
  kill_switch: false,
  paused: false,
  running_total: 0,
  max_concurrent: 1,
  ...over,
});

describe('gates', () => {
  test('a due, enabled flow with every gate clear is ready', () => {
    expect(decide(flow(), sup())).toEqual(expect.objectContaining({ state: 'ready', gate: null }));
  });

  test('each gate holds on its own, and the first in GATES order wins', () => {
    const cases: [Partial<FlowFacts>, Partial<SupervisorFacts>, string][] = [
      [{}, { kill_switch: true }, 'kill_switch'],
      [{}, { paused: true }, 'supervisor_paused'],
      [{ enabled: false }, {}, 'flow_disabled'],
      [{ has_engine: false }, {}, 'no_engine'],
      [{ dial: 'autopilot', dial_confirmed: false }, {}, 'dial_unapproved'],
      [{ caps: { max_usd: null, max_turns: 200, period: 'week' } }, {}, 'cap_required'],
      [{ spend: { usd: 5, turns: 0 } }, {}, 'budget'],
      [{ open_asks: ASK_CAP }, {}, 'open_asks'],
      [{ dry_streak: DRY_STOP }, {}, 'dormant'],
      [{ stall_streak: STALL_STOP }, {}, 'stalled'],
      [{ due: false }, {}, 'not_due'],
      [{ running: 1 }, {}, 'wip'],
      [{}, { running_total: 1 }, 'machine_busy'],
    ];
    for (const [f, s, gate] of cases) expect(decide(flow(f), sup(s)).gate).toBe(gate);
    // Everything wrong at once: the kill switch still names itself, then the pause.
    const all = flow({
      enabled: false,
      has_engine: false,
      spend: { usd: 9, turns: 9 },
      open_asks: 9,
      due: false,
    });
    expect(decide(all, sup({ kill_switch: true, paused: true })).gate).toBe('kill_switch');
    expect(decide(all, sup({ paused: true })).gate).toBe('supervisor_paused');
    expect(new Set(cases.map((c) => c[2]))).toEqual(new Set(GATES));
  });

  test('a running flow with nothing new due reports running, not held', () => {
    expect(decide(flow({ running: 1, due: false }), sup())).toEqual(
      expect.objectContaining({ state: 'running', gate: null }),
    );
  });

  test('a cap that is not set never runs out, so an uncapped flow keeps going', () => {
    expect(capUsed({ max_usd: null, max_turns: null, period: 'week' }, { usd: 1e6, turns: 1e6 })).toBe(false);
    expect(capUsed({ max_usd: null, max_turns: 10, period: 'week' }, { usd: 1e6, turns: 10 })).toBe(true);
    // Only Autopilot may run uncapped (FW-C-035); at Draft or Copilot a flow needs a dollar cap.
    const uncapped = flow({
      dial: 'autopilot',
      dial_confirmed: true,
      caps: { max_usd: null, max_turns: null, period: 'week' },
      spend: { usd: 500, turns: 9000 },
    });
    expect(decide(uncapped, sup()).state).toBe('ready');
    for (const dial of ['draft', 'copilot'] as const)
      expect(decide({ ...uncapped, dial }, sup()).gate).toBe('cap_required');
  });

  test('plan admits ready flows in order, up to the free slots', () => {
    const v = (key: string, ready: boolean) => ({
      key,
      verdict: ready ? decide(flow(), sup()) : decide(flow({ due: false }), sup()),
    });
    const flows = [v('a', false), v('b', true), v('c', true)];
    expect(plan(flows, sup({ max_concurrent: 1 }))).toEqual(['b']);
    expect(plan(flows, sup({ max_concurrent: 3 }))).toEqual(['b', 'c']);
    expect(plan(flows, sup({ max_concurrent: 2, running_total: 2 }))).toEqual([]);
  });
});

describe('the Supervisor in fwd', () => {
  test('lists the shipped flows, each held by flow_disabled until the Owner turns it on', () => {
    const home = tempHome();
    try {
      const keys = shippedFlows(repoRoot).map((f) => f.key);
      expect(keys).toContain('local-saturation');
      withWriter(home.path, (w) => {
        const v = supervisorView({ reader: w, repoRoot, fwHome: home.path });
        expect(v.flows.map((f) => f.key)).toEqual(keys);
        for (const f of v.flows) expect(f.gate).toBe('flow_disabled');
      });
    } finally {
      home.cleanup();
    }
  });

  test('each Owner control writes the setting and one system.config_changed event, and repeats are no-ops', () => {
    const home = tempHome();
    try {
      withWriter(home.path, (w) => {
        const events = () =>
          w.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'system.config_changed'")
            .length;
        const before = events();
        expect(setFlowEnabled(w, repoRoot, 'local-saturation', true).changed).toBe(true);
        expect(setFlowEnabled(w, repoRoot, 'local-saturation', true).changed).toBe(false);
        expect(setPaused(w, true).changed).toBe(true);
        expect(events()).toBe(before + 2);
        expect(readSettings(w)).toEqual({
          version: 1,
          paused: true,
          flows: { 'local-saturation': { enabled: true, dial: 'draft' } },
        });
        const v = supervisorView({ reader: w, repoRoot, fwHome: home.path });
        expect(v.flows.find((f) => f.key === 'local-saturation')?.gate).toBe('supervisor_paused');
        setPaused(w, false);
        const after = supervisorView({ reader: w, repoRoot, fwHome: home.path });
        expect(after.flows.find((f) => f.key === 'local-saturation')?.gate).toBe('not_due');
        expect(() => setFlowEnabled(w, repoRoot, 'no-such-flow', true)).toThrow(/no flow named/);
      });
    } finally {
      home.cleanup();
    }
  });

  test('an engine that throws holds its flow by no_engine with the reason, never lets it pass', () => {
    const home = tempHome();
    try {
      withWriter(home.path, (w) => {
        setFlowEnabled(w, repoRoot, 'local-saturation', true);
        const v = supervisorView({
          reader: w,
          repoRoot,
          fwHome: home.path,
          engines: {
            'local-saturation': () => {
              throw new Error('bad config');
            },
          },
        });
        const f = v.flows.find((x) => x.key === 'local-saturation');
        expect(f?.gate).toBe('no_engine');
        expect(f?.reason).toMatch(/bad config/);
      });
    } finally {
      home.cleanup();
    }
  });
  test("neighborhood activation has an engine, and only this period's spend can use up its cap", () => {
    const home = tempHome();
    const key = 'neighborhood-activation';
    const now = new Date('2026-11-10T12:00:00Z');
    const spentAt = (iso: string) => {
      const dir = join(home.path, 'flows', key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ spend: { period_start: iso, usd: 5, turns: 0 } }),
      );
    };
    try {
      withWriter(home.path, (w) => {
        setFlowEnabled(w, repoRoot, key, true);
        const gate = () =>
          supervisorView({ reader: w, repoRoot, fwHome: home.path, now: () => now }).flows.find(
            (f) => f.key === key,
          )?.gate;
        expect(gate()).toBe('not_due');
        spentAt('2026-11-09T00:00:00Z');
        expect(gate()).toBe('budget');
        spentAt('2026-10-01T00:00:00Z');
        expect(gate()).toBe('not_due');
      });
    } finally {
      home.cleanup();
    }
  });
  test('the dial: autopilot needs the current confirm hash, and a changed channel list holds the flow', () => {
    const home = tempHome();
    const key = 'local-saturation';
    try {
      withWriter(home.path, (w) => {
        setFlowEnabled(w, repoRoot, key, true);
        const view = () =>
          supervisorView({ reader: w, repoRoot, fwHome: home.path }).flows.find((f) => f.key === key);
        expect(view()?.dial).toBe('draft');
        expect(setDial(w, repoRoot, home.path, key, 'copilot').changed).toBe(true);
        expect(setDial(w, repoRoot, home.path, key, 'copilot').changed).toBe(false);
        expect(() => setDial(w, repoRoot, home.path, key, 'turbo')).toThrow(/stop must be one of/);

        let hash = '';
        try {
          setDial(w, repoRoot, home.path, key, 'autopilot');
        } catch (e) {
          expect(e).toBeInstanceOf(SupervisorError);
          expect((e as SupervisorError).code).toBe('CONFIRM_REQUIRED');
          hash = String((e as SupervisorError).details.confirm_hash);
        }
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(() => setDial(w, repoRoot, home.path, key, 'autopilot', 'nope')).toThrow(/Confirm/);
        expect(view()?.dial).toBe('copilot');
        setDial(w, repoRoot, home.path, key, 'autopilot', hash);
        expect(view()?.dial).toBe('autopilot');
        expect(view()?.gate).toBe('not_due');

        // A new channel in the $FW_HOME override changes the hash, so the old confirmation is void.
        const cfg = JSON.parse(readFileSync(join(repoRoot, 'flows', key, 'config.json'), 'utf8'));
        cfg.channels.push({ key: 'x', label: 'X', action_class: 'publish_external' });
        mkdirSync(join(home.path, 'flows', key), { recursive: true });
        writeFileSync(join(home.path, 'flows', key, 'config.json'), JSON.stringify(cfg));
        expect(view()?.gate).toBe('dial_unapproved');

        // Leaving Autopilot drops the confirmation, and the flow is free again at Copilot.
        setDial(w, repoRoot, home.path, key, 'copilot');
        expect(readSettings(w).flows[key]).toEqual({ enabled: true, dial: 'copilot' });
        expect(view()?.gate).toBe('not_due');
        const events = w.all<{ payload: string }>(
          "SELECT payload FROM events WHERE type = 'system.config_changed'",
        );
        expect(events.filter((e) => e.payload.includes('"dial":"autopilot"')).length).toBe(1);
      });
    } finally {
      home.cleanup();
    }
  });
});

describe('the Supervisor decides each scheduled fire (FW-C-036)', () => {
  const fire = (streamKey: string) => ({
    streamKey,
    streamId: 'stm_x',
    fireId: 'f1',
    dueAt: '2026-01-05T10:05:00.000Z',
  });

  test('holds a flow by its gate, admits it once due and clear, and leaves other streams alone', async () => {
    const home = tempHome();
    try {
      // onFire decides synchronously; the verdicts are awaited after the writer closes.
      const verdicts = withWriter(home.path, (w) => {
        const onFire = createSupervisorOnFire({ reader: w, repoRoot, fwHome: home.path });
        const off = onFire(fire('local-saturation'));
        setFlowEnabled(w, repoRoot, 'local-saturation', true);
        const on = onFire(fire('local-saturation'));
        setPaused(w, true);
        const paused = onFire(fire('local-saturation'));
        const other = onFire(fire('not-a-flow'));
        return [off, on, paused, other] as const;
      });
      const [off, on, paused, other] = await Promise.all(verdicts);
      expect(off.outcome).toBe('hold');
      expect(off.reason).toMatch(/^flow_disabled: /);
      // The fire itself makes the flow due, so not_due never holds it.
      expect(on).toEqual({ outcome: 'admit' });
      expect(paused.reason).toMatch(/^supervisor_paused: /);
      expect(other).toEqual({ outcome: 'admit' });
    } finally {
      home.cleanup();
    }
  });

  test('a flow whose engine throws is held by no_engine', async () => {
    const home = tempHome();
    try {
      const [v] = withWriter(home.path, (w) => {
        setFlowEnabled(w, repoRoot, 'local-saturation', true);
        const onFire = createSupervisorOnFire({
          reader: w,
          repoRoot,
          fwHome: home.path,
          engines: {
            'local-saturation': () => {
              throw new Error('boom');
            },
          },
        });
        return [onFire(fire('local-saturation'))] as const;
      });
      expect((await v).reason).toMatch(/^no_engine: .*boom/);
    } finally {
      home.cleanup();
    }
  });
});
