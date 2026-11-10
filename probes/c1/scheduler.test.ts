// Probe c1/scheduler (WS-P1-004; backlog verify_probe kernel/scheduler).
// Surfaces: createScheduler exported by packages/daemon/src/index.ts, driven with a fake clock over a
// real store (openStore from packages/eventlog/src/index.ts on $FW_HOME/db/fw.sqlite with the writer
// lock $FW_HOME/fwd.lock, the way fwd opens it); streams created with `fw stream add -f <file>`; the
// job ledger read back from the `events` table (stream.fired) with node:sqlite read-only.
// The surface this probe expects (no spec names it; see probes/c1/README.md, "Decisions" 19-23):
//   createScheduler({ writer, clock, onFire? }) -> { start(), stop(), fireNow(streamId) }
//     clock: { now(): number (epoch ms), setTimeout(fn, ms): handle, clearTimeout(handle) }
//     onFire({ streamKey, fireId, dueAt }) -> Promise<{ outcome: 'admit' | 'hold', reason? }>;
//       default admits; a hold, and onFire throwing (reason "supervisor error"), are recorded as held
//     fireNow(streamId) -> fires a stream by hand (trigger manual); resolves once it is recorded
//   Every fire, whatever its outcome, is one stream.fired event (the job ledger) whose payload has
//   stream_id, trigger, trigger_ref, fire_id (event_types in schema.core.sql) plus outcome
//   (fired | missed | held | refused), scheduled_for for cron fires, and reason when not fired.
// Acceptance (WS-P1-004):
//   1. a cron stream fires within 1 s of schedule in a fake-clock test
//   2. missed fires after daemon downtime are recorded as missed, not silently dropped
//   3. every fire has a job-ledger row with outcome
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { check, fixtureProject, freshHome, fw, openDbReadonly, requireExport, root, storePath, tmpDir } from '../c0/_lib.mjs';

type Verdict = { outcome: 'admit' | 'hold'; reason?: string };
type FireInfo = { streamKey: string; fireId: string; dueAt: string | number };
type Scheduler = { start(): unknown; stop(): unknown; fireNow(streamId: string): Promise<unknown> };
type Create = (o: Record<string, unknown>) => Scheduler;
type Fired = { stream_id: string; trigger: string; trigger_ref: unknown; fire_id: string; outcome: string; scheduled_for?: string; reason?: string };

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T10:02:00.000Z');
const OUTCOMES = ['fired', 'missed', 'held', 'refused'];

/** A fake clock: time moves only when the probe advances it; due timers run in time order. */
function fakeClock(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { at: now + Math.max(0, ms), fn });
        return id;
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number);
      },
    },
    set: (t: number) => {
      now = t;
    },
    pending: () => timers.size,
    async advanceTo(t: number) {
      await flush();
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = t;
      await flush();
    },
  };
}

const example = () => JSON.parse(readFileSync(join(root, 'contracts-core/examples/24-stream-definition.json'), 'utf8'));
function definition(projectId: string, id: string, key: string, trigger: Record<string, unknown>, enabled = true) {
  const d = example();
  Object.assign(d, { id, key, name: `Probe stream ${key}`, project_id: projectId, version: 1, default_tier: 'L2', enabled, trigger });
  delete d.tier_caps;
  d.inputs = d.inputs.map((i: { kind: string; ref: string }) => ({ ...i, ref: i.kind === 'ledger_rows' ? `ledger://${projectId}?status=ready` : i.ref }));
  return d;
}

const dueMs = (d: string | number) => (typeof d === 'number' ? d : Date.parse(d));
const iso = (t: number) => new Date(t).toISOString();

describe('c1/scheduler', () => {
  const home = freshHome('c1-sched');
  const proj = fixtureProject({ rowId: 'FW-C-964' });
  const o = { home, cwd: proj.work };
  const CRON = 'stm_probesched01';
  const MANUAL = 'stm_probesched02';
  const OFF = 'stm_probesched03';
  let store: { writer: unknown; close(): void } | undefined;
  afterAll(() => store?.close());

  async function fired(): Promise<Fired[]> {
    const db = await openDbReadonly(home);
    const rows = db
      .prepare("SELECT payload, idempotency_key FROM events WHERE type = 'stream.fired' ORDER BY seq")
      .all() as { payload: string; idempotency_key: string }[];
    db.close();
    return rows.map((r) => ({ ...JSON.parse(r.payload), idempotency_key: r.idempotency_key }));
  }

  test('fires on cron within 1 s, records holds, misses after downtime, and manual fires', async () => {
    const createScheduler = (await requireExport('daemon', 'createScheduler', 'WS-P1-004')) as Create;
    const { openStore } = await import(join(root, 'packages/eventlog/src/index.ts'));

    check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
    let db = await openDbReadonly(home);
    const projectId = (db.prepare('SELECT id FROM projects').get() as { id: string }).id;
    db.close();
    const dir = tmpDir('c1-sched-defs');
    const defs = [
      definition(projectId, CRON, 'probe-sched-cron', { type: 'cron', cron: '*/5 * * * *', timezone: 'UTC', catch_up: 'skip' }),
      definition(projectId, MANUAL, 'probe-sched-manual', { type: 'manual' }),
      definition(projectId, OFF, 'probe-sched-off', { type: 'manual' }, false),
    ];
    for (const d of defs) {
      const p = join(dir, `${d.key}.json`);
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
      const r = fw(['stream', 'add', '-f', p, '--json'], o);
      check(r.status === 0, `fw stream add ${d.key} exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)}`);
    }

    // onFire is the hook a Supervisor plugs into. The probe records when it is called (fake time).
    const calls: { info: FireInfo; at: number }[] = [];
    let mode: 'admit' | 'hold' | 'throw' = 'admit';
    const fc = fakeClock(T0);
    const onFire = async (info: FireInfo): Promise<Verdict> => {
      calls.push({ info, at: fc.clock.now() });
      if (mode === 'throw') throw new Error('probe supervisor exploded');
      return mode === 'hold' ? { outcome: 'hold', reason: 'probe hold' } : { outcome: 'admit' };
    };
    const open = () => {
      store = openStore({ path: storePath(home), lockPath: join(home, 'fwd.lock') });
      return createScheduler({ writer: store!.writer, clock: fc.clock, onFire });
    };

    // ---- line 1: a cron stream fires within 1 s of its schedule (fake clock) -----------------
    let sched = open();
    await sched.start();
    const slot1 = Date.parse('2026-01-05T10:05:00.000Z');
    await fc.advanceTo(slot1 - 1000);
    expect(calls.length, 'the cron stream fired a second before its 10:05 slot').toBe(0);
    expect(fc.pending(), 'the scheduler armed no timer for the next cron slot').toBeGreaterThan(0);
    await fc.advanceTo(slot1 + 1000);
    expect(calls.map((c) => c.info.streamKey), 'onFire calls by 10:05:01 (want the cron stream once)').toEqual(['probe-sched-cron']);
    expect(dueMs(calls[0].info.dueAt), 'dueAt of the 10:05 fire').toBe(slot1);
    expect(calls[0].at - slot1, 'ms between the 10:05 slot and the fire (want 0..1000)').toBeGreaterThanOrEqual(0);
    expect(calls[0].at - slot1, 'ms between the 10:05 slot and the fire (want 0..1000)').toBeLessThanOrEqual(1000);
    let ev = (await fired()).filter((e) => e.stream_id === CRON);
    expect(ev.map((e) => [e.trigger, e.outcome, e.scheduled_for]), 'stream.fired for the 10:05 slot').toEqual([['cron', 'fired', iso(slot1)]]);
    expect(ev[0].fire_id, 'fire_id is the onFire fireId').toBe(calls[0].info.fireId);

    // ---- a hold from onFire, and onFire throwing, are recorded as held (fail closed) ------------
    mode = 'hold';
    await fc.advanceTo(slot1 + 5 * MIN + 1000);
    mode = 'throw';
    await fc.advanceTo(slot1 + 10 * MIN + 1000);
    ev = (await fired()).filter((e) => e.stream_id === CRON);
    expect(
      ev.slice(1).map((e) => [e.outcome, e.scheduled_for, e.reason]),
      'the 10:10 fire (onFire holds) and the 10:15 fire (onFire throws)',
    ).toEqual([
      ['held', iso(slot1 + 5 * MIN), 'probe hold'],
      ['held', iso(slot1 + 10 * MIN), 'supervisor error'],
    ]);
    mode = 'admit';

    // ---- line 2: fires missed while the daemon was down are recorded as missed -----------------
    await sched.stop();
    store!.close();
    store = undefined;
    const down = slot1 + 10 * MIN + 1000;
    const back = Date.parse('2026-01-05T11:15:30.000Z');
    fc.set(back); // an hour passes with no daemon (and no timers run)
    sched = open();
    const before = calls.length;
    await sched.start();
    await fc.advanceTo(back + 1000);
    ev = (await fired()).filter((e) => e.stream_id === CRON);
    const missed = ev.filter((e) => e.outcome === 'missed');
    const want: string[] = [];
    for (let t = slot1 + 15 * MIN; t <= back; t += 5 * MIN) want.push(iso(t));
    expect(missed.map((e) => e.scheduled_for), `slots missed between ${iso(down)} and ${iso(back)}`).toEqual(want);
    expect(calls.length - before, 'onFire calls for missed slots (catch_up skip: none)').toBe(0);
    const slot2 = Date.parse('2026-01-05T11:20:00.000Z');
    await fc.advanceTo(slot2 + 1000);
    expect(calls.slice(before).map((c) => dueMs(c.info.dueAt)), 'the first slot after the restart fires').toEqual([slot2]);
    expect(calls[before].at - slot2, 'ms between the 11:20 slot and the fire').toBeLessThanOrEqual(1000);

    // ---- manual triggers: an active stream fires; a draft stream is refused, not dropped ------
    await sched.fireNow(MANUAL);
    await sched.fireNow(OFF);
    await sched.stop();
    ev = await fired();
    const man = ev.filter((e) => e.stream_id === MANUAL);
    expect(man.map((e) => [e.trigger, e.outcome]), 'stream.fired for the manual fire of an active stream').toEqual([['manual', 'fired']]);
    expect(calls.some((c) => c.info.streamKey === 'probe-sched-manual'), 'onFire was asked about the manual fire').toBe(true);
    const off = ev.filter((e) => e.stream_id === OFF);
    expect(off.map((e) => [e.trigger, e.outcome]), 'stream.fired for the manual fire of a draft stream').toEqual([['manual', 'refused']]);
    expect(typeof off[0].reason === 'string' && off[0].reason.length > 0, 'the refusal names a reason').toBe(true);
    expect(calls.some((c) => c.info.streamKey === 'probe-sched-off'), 'onFire was asked about a refused fire').toBe(false);

    // ---- line 3: every fire has one job-ledger row with an outcome ------------------------------
    db = await openDbReadonly(home);
    const types = db.prepare("SELECT count(*) AS n FROM events WHERE type = 'stream.fired'").get() as { n: number };
    db.close();
    const mine = ev.filter((e) => [CRON, MANUAL, OFF].includes(e.stream_id));
    expect(mine.length, 'stream.fired rows: 4 cron fires + missed + 2 manual').toBe(4 + want.length + 2);
    expect(Number(types.n), 'stream.fired rows for streams the probe did not fire').toBe(mine.length);
    for (const e of mine) {
      expect(OUTCOMES, `outcome of ${e.fire_id}`).toContain(e.outcome);
      expect(typeof e.fire_id === 'string' && e.fire_id.includes(e.stream_id), `fire_id ${e.fire_id} names its stream`).toBe(true);
      expect((e as unknown as { idempotency_key: string }).idempotency_key, `idempotency key of ${e.fire_id}`).toBe(e.fire_id);
      expect('trigger_ref' in e, `trigger_ref in ${e.fire_id}`).toBe(true);
      if (e.outcome !== 'fired') expect(typeof e.reason, `reason of ${e.outcome} fire ${e.fire_id}`).toBe('string');
    }
    expect(new Set(mine.map((e) => e.fire_id)).size, 'distinct fire_ids').toBe(mine.length);
  });
});
