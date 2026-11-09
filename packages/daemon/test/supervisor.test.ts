// WS-P0-028: the supervisor is a second layer that does not trust the adapter. A stub adapter that
// ignores every cap (a runaway) stands in for the vendor: the supervisor must breach on its own
// clock and counts, kill the whole process group, and confirm that nothing is left.
import { type ChildProcess, spawn } from 'node:child_process';
import {
  type AdapterEvent,
  type AdapterRun,
  groupAlive,
  type RunMeta,
  type RunResult,
  type RunStep,
  type VendorAdapter,
  type VendorAdapterInput,
} from '@fw/adapters';
import { afterEach, describe, expect, test } from 'vitest';
import { startSupervised, supervise } from '../src/pipeline/supervisor.ts';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-c.pid!, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

interface StubOptions {
  steps?: { cost_usd: number }[];
  /** The adapter's kill does nothing (a buggy adapter): the supervisor must finish the job. */
  brokenKill?: boolean;
  /** End on its own after the steps instead of hanging. */
  finish?: boolean;
}

function step(seq: number, cost_usd: number): RunStep {
  return {
    id: `stp_${seq}`,
    run_id: 'run_stub',
    seq,
    kind: 'model_turn',
    content_ref: null,
    content_hash: '0'.repeat(64),
    tokens_in: 10,
    tokens_out: 10,
    cost_usd,
    started_at: new Date().toISOString(),
    ended_at: null,
    content: 'turn',
  };
}

function stub(o: StubOptions = {}): VendorAdapter & { last?: { pgid: number } } {
  const adapter: VendorAdapter & { last?: { pgid: number } } = {
    name: 'stub',
    vendor: 'local',
    capabilities: { supports_resume: false, supports_schema: false, supports_budget_cap: false },
    start(): AdapterRun {
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      children.push(child);
      const pgid = child.pid!;
      adapter.last = { pgid };
      let end!: () => void;
      const ended = new Promise<void>((ok) => {
        end = ok;
      });
      child.on('exit', () => end());
      const events = (async function* (): AsyncGenerator<AdapterEvent> {
        yield { type: 'process', phase: 'spawned', pgid, at: new Date().toISOString() };
        let seq = 0;
        for (const s of o.steps ?? []) yield { type: 'step', step: step(++seq, s.cost_usd) };
        if (o.finish) process.kill(-pgid, 'SIGKILL');
        await ended;
      })();
      const meta = ended.then(
        (): RunMeta => ({
          fingerprint: null,
          cost: { usd: null, estimated: false } as unknown as RunMeta['cost'],
          failure_class: null,
          cap_breach: null,
          killed_reason: null,
          pgid,
          error_count: 0,
          artifact_sources: [],
          stderr_tail: [],
        }),
      );
      return {
        run_id: 'run_stub',
        events,
        result: ended.then(() => ({ status: 'completed' }) as unknown as RunResult),
        meta,
        async kill() {
          if (!o.brokenKill) process.kill(-pgid, 'SIGKILL');
          else end(); // reports done while the group lives on
        },
        pgid: () => pgid,
      };
    },
    fingerprint: async () => {
      throw new Error('not used');
    },
    preflight: async () => {
      throw new Error('not used');
    },
  };
  return adapter;
}

function input(caps: { wall_s?: number; turns?: number; usd?: number } = {}): VendorAdapterInput {
  return {
    caps: { max_wall_clock_s: caps.wall_s ?? 60, max_turns: caps.turns ?? 100 },
    budget: { max_usd: caps.usd, max_turns: caps.turns },
  } as unknown as VendorAdapterInput;
}

describe('supervisor', () => {
  test('wall clock: a runaway that ignores its caps is killed on the supervisor clock, group confirmed gone', async () => {
    const a = stub();
    const t0 = Date.now();
    const seen: AdapterEvent[] = [];
    const out = await startSupervised(a, input({ wall_s: 1 }), {
      onEvent: (e) => seen.push(e),
      killGraceMs: 100,
    }).done;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.breach).toMatchObject({ cap: 'wall_clock', limit: 1, by: 'supervisor' });
    expect(seen.filter((e) => e.type === 'cap_breach')).toHaveLength(1); // reported once
    expect(out.group_gone).toBe(true);
    expect(groupAlive(a.last!.pgid)).toBe(false);
  });

  test('turns: the supervisor counts model turns itself', async () => {
    const out = await supervise(
      stub({ steps: [{ cost_usd: 0 }, { cost_usd: 0 }, { cost_usd: 0 }] }),
      input({ turns: 2 }),
    );
    expect(out.cap_breach).toMatchObject({ cap: 'turns', limit: 2, observed: 3, by: 'supervisor' });
  });

  test('usd: the supervisor sums step cost against the budget', async () => {
    const out = await supervise(stub({ steps: [{ cost_usd: 0.4 }, { cost_usd: 0.4 }] }), input({ usd: 0.5 }));
    expect(out.cap_breach).toMatchObject({ cap: 'usd', limit: 0.5, by: 'supervisor' });
    expect(out.cap_breach?.observed).toBeCloseTo(0.8);
  });

  test('a broken adapter kill does not leave the group alive: the supervisor kills it', async () => {
    const a = stub({ brokenKill: true });
    const out = await startSupervised(a, input({ wall_s: 1 }), { killGraceMs: 100 }).done;
    expect(out.breach?.cap).toBe('wall_clock');
    expect(out.group_gone).toBe(true);
    expect(groupAlive(a.last!.pgid)).toBe(false);
  });

  test('stop(): an outside reason (the budget backstop) is recorded and not reported as a breach', async () => {
    const a = stub();
    const s = startSupervised(a, input({ wall_s: 60 }), { killGraceMs: 100 });
    await new Promise((ok) => setTimeout(ok, 100));
    await s.stop('database budget hard stop');
    const out = await s.done;
    expect(out.stopped).toBe('database budget hard stop');
    expect(out.breach).toBeNull();
    expect(out.group_gone).toBe(true);
  });

  test('a run that ends within its caps has no breach', async () => {
    const out = await supervise(
      stub({ steps: [{ cost_usd: 0.01 }], finish: true }),
      input({ turns: 5, usd: 1 }),
    );
    expect(out.cap_breach).toBeNull();
  });

  test('a throwing observer never keeps a runaway alive', async () => {
    const a = stub();
    const out = await startSupervised(a, input({ wall_s: 1 }), {
      onEvent: () => {
        throw new Error('observer bug');
      },
      killGraceMs: 100,
    }).done;
    expect(out.breach?.cap).toBe('wall_clock');
    expect(groupAlive(a.last!.pgid)).toBe(false);
  });
});
