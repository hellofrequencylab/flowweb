// The scheduler: fires active streams on their cron schedule and by hand, and records every fire as
// one stream.fired event (the job ledger) with its outcome: fired, missed, held or refused.
//   - Each cron slot wakes the scheduler at slot + jitter (jitter < 1 s, so a fire is never more than
//     a second late). A slot found more than GRACE_MS in the past (fwd was down, or the machine slept)
//     is recorded as missed; with catch_up run_once the newest missed slot is fired late instead.
//   - On start, the gap since the last recorded cron fire of each stream is replayed the same way, so
//     downtime leaves one missed row per slot instead of nothing.
//   - Before a fire is recorded as fired, onFire is asked (the Supervisor's hook). It may hold the
//     fire with a reason; if it throws, the fire is held with reason "supervisor error" (fail closed).
// The clock is injectable so tests drive time.
import { randomBytes } from 'node:crypto';
import type { Writer } from '@fw/eventlog';
import { type Cron, parseCron } from './cron.ts';

export type FireOutcome = 'fired' | 'missed' | 'held' | 'refused';
export type FireTrigger = 'cron' | 'manual';

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2 ** 31 - 1)).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface FireRequest {
  streamKey: string;
  streamId: string;
  fireId: string;
  /** ISO time the fire was due (the cron slot, or the moment of a manual fire). */
  dueAt: string;
}
export interface FireVerdict {
  outcome: 'admit' | 'hold';
  reason?: string;
}
export type OnFire = (fire: FireRequest) => Promise<FireVerdict>;

export interface FireRecord {
  stream_id: string;
  trigger: FireTrigger;
  trigger_ref: string | null;
  fire_id: string;
  outcome: FireOutcome;
  scheduled_for?: string;
  reason?: string;
  decided_at: string;
}

export interface SchedulerOptions {
  writer: Writer;
  clock?: SchedulerClock;
  onFire?: OnFire;
  /** Upper bound of the random delay added to each cron wake-up (default 500 ms, capped below 1 s). */
  jitterMs?: number;
  random?: () => number;
  log?: (line: string) => void;
}

export interface Scheduler {
  /** Loads the active cron streams, records fires missed since the last run, and arms the timers. */
  start(): Promise<void>;
  /** Disarms every timer and waits for fires in progress. */
  stop(): Promise<void>;
  /** Fires one stream by hand (trigger manual). Refused, and recorded as refused, unless active. */
  fireNow(streamId: string, opts?: { ref?: string }): Promise<FireRecord>;
}

/** A slot older than this when the scheduler looks at it was missed. */
export const GRACE_MS = 1000;
/** Missed slots recorded one by one per catch-up; older ones are counted on the last row. */
export const MAX_MISSED_RECORDED = 1000;

interface StreamRow {
  id: string;
  project_id: string;
  key: string;
  status: string;
  definition: string;
}
interface CronStream extends StreamRow {
  cron: Cron;
  runOnce: boolean;
  cursor: number;
  timer?: unknown;
  chain: Promise<void>;
}

const iso = (t: number) => new Date(t).toISOString();
const MISSED_REASON = 'the scheduler did not run within 1 s of this slot (fwd down or asleep)';
/** The job-ledger fields of cron slot t; fire_id is stream id + scheduled time (event_types). */
const cronFire = (s: StreamRow, t: number) => {
  const slot = iso(t);
  return { trigger: 'cron' as const, trigger_ref: slot, fire_id: `${s.id}:${slot}`, scheduled_for: slot };
};

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const w = opts.writer;
  const clock = opts.clock ?? systemClock;
  const onFire: OnFire = opts.onFire ?? (async () => ({ outcome: 'admit' }));
  const jitterMs = Math.min(Math.max(opts.jitterMs ?? 500, 0), GRACE_MS - 1);
  const random = opts.random ?? Math.random;
  const log = opts.log ?? (() => {});
  const crons = new Map<string, CronStream>();
  let running = false;

  const record = (s: StreamRow, r: Omit<FireRecord, 'stream_id' | 'decided_at'>, extra = {}): FireRecord => {
    const rec: FireRecord = { stream_id: s.id, ...r, decided_at: iso(clock.now()) };
    w.transaction((tx) => {
      tx.appendEvent({
        type: 'stream.fired',
        actor_kind: 'system',
        actor_id: 'scheduler',
        project_id: s.project_id,
        stream_id: s.id,
        idempotency_key: rec.fire_id,
        payload: { ...rec, ...extra },
      });
      if (rec.outcome === 'fired')
        tx.run('UPDATE streams SET last_fired_at = ? WHERE id = ?', [rec.decided_at, s.id]);
    });
    return rec;
  };

  /** Asks onFire, then records the fire as fired or held. */
  const decide = async (
    s: StreamRow,
    fire: Omit<FireRecord, 'stream_id' | 'decided_at' | 'outcome'>,
    dueAt: string,
  ): Promise<FireRecord> => {
    let v: FireVerdict;
    try {
      v = await onFire({ streamKey: s.key, streamId: s.id, fireId: fire.fire_id, dueAt });
    } catch (e) {
      log(`scheduler: onFire threw for ${fire.fire_id}: ${(e as Error)?.message ?? e}`);
      v = { outcome: 'hold', reason: 'supervisor error' };
    }
    if (v?.outcome === 'admit') return record(s, { ...fire, outcome: 'fired' });
    return record(s, { ...fire, outcome: 'held', reason: v?.reason || 'held by supervisor' });
  };

  /** Handles every slot of s up to now, then arms the timer for the next one. */
  const tick = async (s: CronStream): Promise<void> => {
    const now = clock.now();
    const due: number[] = [];
    for (let t = s.cron.next(s.cursor); t !== undefined && t <= now; t = s.cron.next(t)) due.push(t);
    const late = due.filter((t) => now - t > GRACE_MS);
    const lateFire = s.runOnce && late.length > 0 && late.length === due.length ? late.pop() : undefined;
    const skipped = Math.max(0, late.length - MAX_MISSED_RECORDED);
    late.forEach((t, i) => {
      if (i < skipped) return;
      const extra = i === late.length - 1 && skipped > 0 ? { earlier_missed_not_recorded: skipped } : {};
      record(s, { ...cronFire(s, t), outcome: 'missed', reason: MISSED_REASON }, extra);
      s.cursor = t;
    });
    for (const t of due.filter((x) => now - x <= GRACE_MS || x === lateFire)) {
      await decide(s, cronFire(s, t), iso(t));
      s.cursor = t;
    }
    if (!running) return;
    const next = s.cron.next(s.cursor);
    if (next === undefined) return;
    const wait = next + Math.floor(random() * jitterMs) - clock.now();
    s.timer = clock.setTimeout(
      () => {
        s.timer = undefined;
        enqueue(s);
      },
      Math.max(0, wait),
    );
  };

  const enqueue = (s: CronStream) => {
    s.chain = s.chain
      .then(() => (running ? tick(s) : undefined))
      .catch((e) => {
        log(`scheduler: stream ${s.id} tick failed: ${(e as Error)?.message ?? e}`);
      });
    return s.chain;
  };

  const lastSlot = (id: string): number | undefined => {
    const r = w.get<{ s: string | null }>(
      `SELECT max(json_extract(payload, '$.scheduled_for')) AS s FROM events
       WHERE type = 'stream.fired' AND stream_id = ? AND json_extract(payload, '$.trigger') = 'cron'`,
      [id],
    );
    return r?.s ? Date.parse(r.s) : undefined;
  };

  const SELECT = 'SELECT id, project_id, key, status, definition FROM streams';

  return {
    async start() {
      if (running) return;
      running = true;
      for (const row of w.all<StreamRow>(`${SELECT} WHERE status = 'active' ORDER BY id`)) {
        const trig = (JSON.parse(row.definition) as { trigger?: Record<string, string> }).trigger ?? {};
        if (trig.type !== 'cron' || !trig.cron) continue;
        let cron: Cron;
        try {
          cron = parseCron(trig.cron, trig.timezone ?? 'UTC');
        } catch (e) {
          log(`scheduler: stream ${row.id} not scheduled: ${(e as Error).message}`);
          continue;
        }
        const cursor = lastSlot(row.id) ?? clock.now();
        crons.set(row.id, {
          ...row,
          cron,
          runOnce: trig.catch_up === 'run_once',
          cursor,
          chain: Promise.resolve(),
        });
      }
      await Promise.all([...crons.values()].map(enqueue));
    },
    async stop() {
      running = false;
      for (const s of crons.values()) if (s.timer !== undefined) clock.clearTimeout(s.timer);
      await Promise.all([...crons.values()].map((s) => s.chain));
      crons.clear();
    },
    async fireNow(streamId, o = {}) {
      const s = w.get<StreamRow>(`${SELECT} WHERE id = ?`, [streamId]);
      if (!s) throw new Error(`stream ${streamId} is not in the ledger`);
      const at = iso(clock.now());
      const fire = {
        trigger: 'manual' as const,
        trigger_ref: o.ref ?? null,
        fire_id: `${s.id}:manual:${at}:${randomBytes(4).toString('hex')}`,
      };
      if (s.status !== 'active')
        return record(s, { ...fire, outcome: 'refused', reason: `stream is ${s.status}, not active` });
      return decide(s, fire, at);
    },
  };
}
