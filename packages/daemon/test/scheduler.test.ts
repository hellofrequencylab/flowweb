// WS-P1-004: the scheduler's catch-up, jitter and refusals, on a real store with a fake clock.
import { join } from 'node:path';
import { openStore, type Store, type Writer } from '@fw/eventlog';
import { afterEach, describe, expect, test } from 'vitest';
import { ensureFwHome } from '../src/daemon.ts';
import { createScheduler, type SchedulerClock } from '../src/scheduler/index.ts';
import { tempHome } from './api-fixtures.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T10:02:00.000Z');

/** A fake clock: `to(t)` moves time to t and runs the timers due by then, once each. */
function fakeClock(start: number) {
  let now = start;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SchedulerClock = {
    now: () => now,
    setTimeout: (fn, ms) => timers.set(++id, { at: now + ms, fn }) && id,
    clearTimeout: (h) => timers.delete(h as number),
  };
  const flush = () => new Promise((r) => setTimeout(r, 20));
  return {
    clock,
    timers,
    async to(t: number) {
      now = t;
      for (const [k, x] of [...timers]) if (x.at <= t && timers.delete(k)) x.fn();
      await flush();
    },
  };
}

let store: Store | undefined;
const cleanups: (() => void)[] = [];
afterEach(() => {
  store?.close();
  store = undefined;
  for (const c of cleanups.splice(0)) c();
});

function setup(streams: { id: string; status?: string; trigger: Record<string, string> }[]): Writer {
  const home = tempHome();
  cleanups.push(home.cleanup);
  ensureFwHome(home.path);
  store = openStore({ path: join(home.path, 'db', 'fw.sqlite'), lockPath: join(home.path, 'fwd.lock') });
  const w = store.writer!;
  w.run("INSERT INTO projects(id, slug, name, repo_url) VALUES ('prj_test0001', 'atlas', 'Atlas', 'x')");
  for (const s of streams)
    w.run(
      `INSERT INTO streams(id, project_id, key, name, template, definition, definition_hash, status)
       VALUES (?, 'prj_test0001', ?, ?, 'custom', ?, ?, ?)`,
      [
        s.id,
        s.id.slice(4),
        s.id,
        JSON.stringify({ trigger: s.trigger }),
        'b'.repeat(64),
        s.status ?? 'active',
      ],
    );
  return w;
}

const fires = (w: Writer, id: string) =>
  w
    .all<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'stream.fired' AND stream_id = ? ORDER BY seq",
      [id],
    )
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);

describe('createScheduler', () => {
  test('catch_up run_once fires the newest missed slot late and records the rest as missed', async () => {
    const w = setup([
      { id: 'stm_once0001', trigger: { type: 'cron', cron: '*/5 * * * *', catch_up: 'run_once' } },
    ]);
    const fc = fakeClock(T0);
    let s = createScheduler({ writer: w, clock: fc.clock, random: () => 0 });
    await s.start();
    await fc.to(T0 + 3 * MIN + 10);
    await s.stop();
    await fc.to(T0 + 18 * MIN); // 10:20: down through 10:10, 10:15 and 10:20 was 0 ms ago
    s = createScheduler({ writer: w, clock: fc.clock, random: () => 0 });
    await s.start();
    await s.stop();
    expect(fires(w, 'stm_once0001').map((f) => [f.scheduled_for, f.outcome])).toEqual([
      ['2026-01-05T10:05:00.000Z', 'fired'],
      ['2026-01-05T10:10:00.000Z', 'missed'],
      ['2026-01-05T10:15:00.000Z', 'missed'],
      ['2026-01-05T10:20:00.000Z', 'fired'],
    ]);
    await fc.to(T0 + 31 * MIN); // 10:33: 10:25 missed, 10:30 (also missed) fired late
    s = createScheduler({ writer: w, clock: fc.clock, random: () => 0 });
    await s.start();
    await s.stop();
    expect(
      fires(w, 'stm_once0001')
        .slice(4)
        .map((f) => [f.scheduled_for, f.outcome]),
    ).toEqual([
      ['2026-01-05T10:25:00.000Z', 'missed'],
      ['2026-01-05T10:30:00.000Z', 'fired'],
    ]);
    expect(w.get<{ t: string }>("SELECT last_fired_at AS t FROM streams WHERE id = 'stm_once0001'")?.t).toBe(
      new Date(T0 + 31 * MIN).toISOString(),
    );
  });

  test('jitter delays the wake-up but stays under a second, and stop disarms it', async () => {
    const w = setup([{ id: 'stm_jitt0001', trigger: { type: 'cron', cron: '* * * * *' } }]);
    const fc = fakeClock(T0);
    const s = createScheduler({ writer: w, clock: fc.clock, jitterMs: 5000, random: () => 0.999999 });
    await s.start();
    const [timer] = [...fc.timers.values()];
    expect(timer!.at - (T0 + MIN)).toBeGreaterThan(900);
    expect(timer!.at - (T0 + MIN)).toBeLessThan(1000);
    await s.stop();
    expect(fc.timers.size).toBe(0);
  });

  test('streams that are not active or have a bad cron are not scheduled; unknown ids throw', async () => {
    const w = setup([
      { id: 'stm_paus0001', status: 'paused', trigger: { type: 'cron', cron: '* * * * *' } },
      { id: 'stm_badc0001', trigger: { type: 'cron', cron: '99 * * * *' } },
    ]);
    const fc = fakeClock(T0);
    const lines: string[] = [];
    const s = createScheduler({ writer: w, clock: fc.clock, log: (l) => lines.push(l) });
    await s.start();
    expect(fc.timers.size).toBe(0);
    expect(lines.join('\n')).toMatch(/stm_badc0001 not scheduled/);
    const r = await s.fireNow('stm_paus0001', { ref: 'by hand' });
    expect([r.outcome, r.trigger_ref, r.reason]).toEqual([
      'refused',
      'by hand',
      'stream is paused, not active',
    ]);
    await expect(s.fireNow('stm_none0001')).rejects.toThrow(/not in the ledger/);
    await s.stop();
  });
});
