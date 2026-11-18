// Probe for FW-C-153 (a flow's morning run still happens when the Mac reaches the slot late):
// `pnpm probe flows/late-wake`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: flows/neighborhood-activation/stream.json as shipped; a real fwd on a fresh FW_HOME (CLI token,
// FW_VENDOR=fake) to turn the flow on; the streams and events tables read with node:sqlite; createScheduler,
// createSupervisorOnFire and parseCron exported by packages/daemon/src/index.ts, driven with a clock that
// wakes late over the real store (openStore with the writer lock, the way fwd opens it).
// Why: on the Owner's Mac every 06:00 fire of the flow from 2026-11-11 to 2026-11-18 was recorded as
// missed, because the timer woke between 1.0 and 3.3 seconds after the slot and the stream said
// catch_up "skip". No scheduled cycle ever ran; only runs started by hand did.
// The surface this probe expects:
//   The shipped stream's trigger.catch_up is "run_once", and a stream registered by turning the flow on
//   carries it.
//   A scheduler that reaches the flow's slot late fires that slot once (outcome fired, scheduled_for the
//   slot) and records no missed row for it.
//   A stream registered earlier with "skip" is brought in line when fwd starts: a new version, one
//   stream.updated event, trigger.catch_up "run_once".
//
// Proves, in order:
//   1. The shipped stream says run_once, and the registered stream does too.
//   2. A slot reached 90 seconds late is fired, not missed.
//   3. An older registration that says skip says run_once after fwd starts again.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  freshHome,
  missing,
  openDbAsAttacker,
  openDbReadonly,
  probe,
  requireExport,
  root,
  storePath,
} from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/late-wake';
const ROW = 'FW-C-153';
const KEY = 'neighborhood-activation';
const LATE_MS = 90_000;
const ENV = { FW_VENDOR: 'fake' };

async function stream(home) {
  const db = await openDbReadonly(home);
  const row = db.prepare('SELECT id, version, definition FROM streams WHERE key = ?').get(KEY);
  db.close();
  check(row, `no stream is registered for ${KEY}`);
  return { id: row.id, version: row.version, def: JSON.parse(row.definition) };
}

async function events(home, type, streamId) {
  const db = await openDbReadonly(home);
  const rows = db
    .prepare('SELECT payload FROM events WHERE type = ? AND stream_id = ? ORDER BY seq')
    .all(type, streamId);
  db.close();
  return rows.map((r) => JSON.parse(r.payload));
}

await probe(NAME, async () => {
  // ---- 1. shipped and registered ---------------------------------------------------------------------
  const shipped = JSON.parse(readFileSync(join(root, 'flows', KEY, 'stream.json'), 'utf8'));
  if (shipped.trigger?.catch_up !== 'run_once')
    missing(
      `flows/${KEY}/stream.json has trigger.catch_up ${JSON.stringify(shipped.trigger?.catch_up)}, want "run_once" (row ${ROW})`,
    );
  const home = realpathSync(freshHome('late-wake'));
  let f = await startFwd(home, { env: ENV });
  try {
    const r = await api(f.port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, { auth: f.token });
    check(r.status === 200, `enabling ${KEY} answered ${r.status}: ${r.text.slice(0, 200)}`);
  } finally {
    await f.stop();
  }
  const reg = await stream(home);
  check(
    reg.def.trigger?.catch_up === 'run_once',
    `the registered stream has catch_up ${JSON.stringify(reg.def.trigger?.catch_up)}`,
  );

  // ---- 2. a slot reached late is fired ---------------------------------------------------------------
  const createScheduler = await requireExport('daemon', 'createScheduler', ROW);
  const createSupervisorOnFire = await requireExport('daemon', 'createSupervisorOnFire', ROW);
  const parseCron = await requireExport('daemon', 'parseCron', ROW);
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);
  const store = openStore({ path: storePath(home), lockPath: join(home, 'fwd.lock') });
  try {
    let now = Date.now();
    const timers = [];
    const clock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const t = { at: now + Math.max(0, ms), fn };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        const i = timers.indexOf(h);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const settle = async () => {
      for (let i = 0; i < 50; i++) await new Promise((ok) => setImmediate(ok));
    };
    const onFire = createSupervisorOnFire({
      reader: store.writer,
      repoRoot: root,
      fwHome: home,
      now: () => new Date(now),
    });
    const sched = createScheduler({ writer: store.writer, clock, onFire, jitterMs: 0 });
    await sched.start();
    await settle();
    const before = (await events(home, 'stream.fired', reg.id)).length;
    check(timers.length > 0, 'the scheduler armed no timer');
    // The machine was asleep: every timer due by then is delivered 90 seconds after the flow's slot.
    const slot = parseCron(reg.def.trigger.cron, reg.def.trigger.timezone).next(now);
    now = slot + LATE_MS;
    for (const t of timers.filter((x) => x.at <= now)) {
      clock.clearTimeout(t);
      t.fn();
      await settle();
    }
    await sched.stop();
    const after = (await events(home, 'stream.fired', reg.id)).slice(before);
    const at = new Date(slot).toISOString();
    const mine = after.filter((e) => e.scheduled_for === at);
    check(mine.length === 1, `the late slot ${at} has ${mine.length} stream.fired rows: ${JSON.stringify(after)}`);
    check(
      mine[0].outcome === 'fired',
      `the late slot was ${mine[0].outcome} (${mine[0].reason ?? 'no reason'}), want fired`,
    );
    check(!after.some((e) => e.outcome === 'missed'), `a missed row was recorded: ${JSON.stringify(after)}`);
  } finally {
    store.close();
  }

  // ---- 3. an older registration is brought in line when fwd starts -----------------------------------
  const old = { ...reg.def, trigger: { ...reg.def.trigger, catch_up: 'skip' } };
  const db = await openDbAsAttacker(home);
  db.prepare('UPDATE streams SET definition = ? WHERE key = ?').run(JSON.stringify(old), KEY);
  db.close();
  check((await stream(home)).def.trigger.catch_up === 'skip', 'could not set up the older registration');
  const updatesBefore = (await events(home, 'stream.updated', reg.id)).length;
  f = await startFwd(home, { env: ENV });
  await f.stop();
  const fixed = await stream(home);
  check(
    fixed.def.trigger.catch_up === 'run_once',
    `after fwd started, the older registration still says ${fixed.def.trigger.catch_up}`,
  );
  check(fixed.version > reg.version, `the stream version did not move (${reg.version} to ${fixed.version})`);
  const updates = (await events(home, 'stream.updated', reg.id)).length - updatesBefore;
  check(updates === 1, `fwd recorded ${updates} stream.updated events for the change, want 1`);
});
