// FW-C-153: a flow stream registered with the old late-slot rule follows the shipped stream.json, so a
// Mac that wakes a second late fires the morning run instead of recording it as missed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStore, type Store, type Writer } from '@fw/eventlog';
import { addStream } from '@fw/ledger';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome } from '../src/daemon.ts';
import { syncFlowCatchUp } from '../src/overseer/cycle.ts';
import { createScheduler, type SchedulerClock } from '../src/scheduler/index.ts';
import { tempHome } from './api-fixtures.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const KEY = 'neighborhood-activation';
const shipped = () =>
  JSON.parse(readFileSync(join(REPO, 'flows', KEY, 'stream.json'), 'utf8')) as {
    id: string;
    project_id: string;
    trigger: Record<string, string>;
  };

let store: Store | undefined;
const cleanups: (() => void)[] = [];
afterEach(() => {
  store?.close();
  store = undefined;
  for (const c of cleanups.splice(0)) c();
});

/** A store holding the flow's stream as it was registered before the shipped file changed. */
function oldRegistration(): Writer {
  const home = tempHome();
  cleanups.push(home.cleanup);
  ensureFwHome(home.path);
  store = openStore({ path: join(home.path, 'db', 'fw.sqlite'), lockPath: join(home.path, 'fwd.lock') });
  const w = store.writer!;
  const def = shipped();
  w.run('INSERT INTO projects(id, slug, name, repo_url) VALUES (?, ?, ?, ?)', [
    def.project_id,
    'frequency',
    'Frequency',
    'x',
  ]);
  addStream(w, { ...def, enabled: true, trigger: { ...def.trigger, catch_up: 'skip' } } as never);
  return w;
}

const registered = (w: Writer) => {
  const r = w.get<{ version: number; definition: string }>(
    'SELECT version, definition FROM streams WHERE key = ?',
    [KEY],
  )!;
  return { version: r.version, trigger: JSON.parse(r.definition).trigger as Record<string, string> };
};

test('the shipped saturation stream fires a late slot once', () => {
  expect(shipped().trigger.catch_up).toBe('run_once');
});

test('an older registration is brought in line once, with a new version and one event', () => {
  const w = oldRegistration();
  const before = registered(w);
  expect(before.trigger.catch_up).toBe('skip');
  expect(syncFlowCatchUp(w, REPO)).toEqual([KEY]);
  const after = registered(w);
  expect(after.trigger.catch_up).toBe('run_once');
  expect(after.trigger.cron).toBe(before.trigger.cron);
  expect(after.version).toBe(before.version + 1);
  expect(syncFlowCatchUp(w, REPO)).toEqual([]);
  expect(registered(w).version).toBe(after.version);
  const updates = w.all("SELECT 1 FROM events WHERE type = 'stream.updated'");
  expect(updates.length).toBe(1);
});

test('after the fix a slot reached 90 seconds late is fired, not missed', async () => {
  const w = oldRegistration();
  syncFlowCatchUp(w, REPO);
  const id = shipped().id;
  let now = Date.parse('2026-11-18T13:00:00.000Z');
  const timers: { at: number; fn: () => void }[] = [];
  const clock: SchedulerClock = {
    now: () => now,
    setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
    clearTimeout: () => {},
  };
  const sched = createScheduler({ writer: w, clock, jitterMs: 0 });
  await sched.start();
  // The shipped cron is 07:00 in Los Angeles on weekdays, 15:00Z on this Wednesday; the machine wakes 90 seconds late.
  const slot = Date.parse('2026-11-18T15:00:00.000Z');
  now = slot + 90_000;
  for (const t of timers.splice(0)) t.fn();
  await new Promise((r) => setTimeout(r, 30));
  await sched.stop();
  const fired = w
    .all<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'stream.fired' AND stream_id = ? ORDER BY seq",
      [id],
    )
    .map((r) => JSON.parse(r.payload) as { outcome: string; scheduled_for: string });
  expect(fired.map((f) => [f.outcome, f.scheduled_for])).toEqual([['fired', new Date(slot).toISOString()]]);
});
