// Probe for FW-C-036 (the Supervisor decides every scheduled fire of a flow): `pnpm probe flows/fire`.
// Tier 0.
// Surfaces: createScheduler and createSupervisorOnFire exported by packages/daemon/src/index.ts, driven
// with a fake clock over a real store (openStore on $FW_HOME/db/fw.sqlite with the writer lock, the
// way fwd opens it); the Owner controls setFlowEnabled, setPaused and setDial exported by the same
// package; streams created with `fw stream add -f <file>`; the job ledger read back from the events
// table (stream.fired) with node:sqlite read-only; one step that engages the kill switch in the
// settings table through the store's writer; and the daemon fwd itself for the last step.
// The surface this probe expects:
//   createSupervisorOnFire({ reader, repoRoot, fwHome, now? }) -> onFire for createScheduler.
//   A fire of a stream whose key names a flow shipped under flows/ is admitted when the Supervisor
//   would let that flow run; the fire itself makes the flow due, so not_due never holds it. Otherwise
//   it is held, and the reason starts with the gate's name ("<gate>: <plain-English reason>").
//   A fire of a stream that is not a flow is decided as before (admitted).
//   fwd passes it to its scheduler as the default onFire.
//
// Proves, in order (one cron slot every 5 minutes, fake clock):
//   1. A fresh flow's fire is held by flow_disabled; a stream that is not a flow still fires.
//   2. Once the Owner enables the flow, its fire is recorded as fired (not held by not_due).
//   3. A paused Supervisor holds the fire by supervisor_paused.
//   4. A flow at Autopilot whose channels changed since the Owner confirmed is held by dial_unapproved.
//   5. A flow whose logic fails (an unreadable config) is held by no_engine: a gate failure is a deny.
//   6. With the kill switch engaged, the flow's fire is held by kill_switch.
//   7. fwd uses the Supervisor by default: a real fwd, with a flow stream due every minute, records
//      that stream's first fire as held by flow_disabled.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  check,
  DAEMON_BIN,
  fixtureProject,
  freshHome,
  fw,
  killAndWait,
  openDbReadonly,
  requireExport,
  root,
  spawnTs,
  storePath,
  tmpDir,
  waitFor,
} from '../c0/_lib.mjs';

type Verdict = { outcome: 'admit' | 'hold'; reason?: string };
type FireInfo = { streamKey: string; streamId: string; fireId: string; dueAt: string };
type OnFire = (f: FireInfo) => Promise<Verdict>;
type Scheduler = { start(): Promise<void>; stop(): Promise<void> };
type Fired = { stream_id: string; outcome: string; scheduled_for?: string; reason?: string };

const ROW = 'FW-C-036';
const KEY = 'local-saturation';
const MIN = 60_000;
const T0 = Date.parse('2026-01-05T10:02:00.000Z');
const FLOW = 'stm_probefire001';
const OTHER = 'stm_probefire002';

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
function definition(projectId: string, id: string, key: string, cron: string) {
  const d = example();
  Object.assign(d, {
    id,
    key,
    name: `Probe stream ${key}`,
    project_id: projectId,
    version: 1,
    default_tier: 'L2',
    enabled: true,
    trigger: { type: 'cron', cron, timezone: 'UTC', catch_up: 'skip' },
  });
  delete d.tier_caps;
  d.inputs = d.inputs.map((i: { kind: string; ref: string }) => ({
    ...i,
    ref: i.kind === 'ledger_rows' ? `ledger://${projectId}?status=ready` : i.ref,
  }));
  return d;
}

/** Adds streams to a fresh home's fixture project with `fw stream add`. */
async function addStreams(home: string, rowId: string, streams: { id: string; key: string; cron: string }[]) {
  const proj = fixtureProject({ rowId });
  const o = { home, cwd: proj.work };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  const db = await openDbReadonly(home);
  const projectId = (db.prepare('SELECT id FROM projects').get() as { id: string }).id;
  db.close();
  const dir = tmpDir('flows-fire-defs');
  for (const s of streams) {
    const p = join(dir, `${s.id}.json`);
    writeFileSync(p, `${JSON.stringify(definition(projectId, s.id, s.key, s.cron), null, 2)}\n`);
    const r = fw(['stream', 'add', '-f', p, '--json'], o);
    check(r.status === 0, `fw stream add ${s.key} exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)}`);
  }
}

async function fired(home: string, streamId: string): Promise<Fired[]> {
  const db = await openDbReadonly(home);
  const rows = db
    .prepare("SELECT payload FROM events WHERE type = 'stream.fired' ORDER BY seq")
    .all() as { payload: string }[];
  db.close();
  return rows.map((r) => JSON.parse(r.payload) as Fired).filter((e) => e.stream_id === streamId);
}

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => ok(port));
    });
  });
}

describe('flows/fire', () => {
  const kids: { exitCode: number | null }[] = [];
  let store: { writer: unknown; close(): void } | undefined;
  afterAll(async () => {
    store?.close();
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  });

  test('the Supervisor holds or admits every scheduled fire of a flow, naming the gate', async () => {
    const createScheduler = (await requireExport('daemon', 'createScheduler', ROW)) as (o: object) => Scheduler;
    const createSupervisorOnFire = (await requireExport('daemon', 'createSupervisorOnFire', ROW)) as (o: object) => OnFire;
    const setFlowEnabled = (await requireExport('daemon', 'setFlowEnabled', ROW)) as (...a: unknown[]) => unknown;
    const setPaused = (await requireExport('daemon', 'setPaused', ROW)) as (...a: unknown[]) => unknown;
    const setDial = (await requireExport('daemon', 'setDial', ROW)) as (...a: unknown[]) => unknown;
    const { openStore } = await import(join(root, 'packages/eventlog/src/index.ts'));

    const home = freshHome('flows-fire');
    await addStreams(home, 'FW-C-963', [
      { id: FLOW, key: KEY, cron: '*/5 * * * *' },
      { id: OTHER, key: 'probe-not-a-flow', cron: '*/5 * * * *' },
    ]);
    store = openStore({ path: storePath(home), lockPath: join(home, 'fwd.lock') });
    const w = store!.writer;
    const fc = fakeClock(T0);
    const onFire = createSupervisorOnFire({ reader: w, repoRoot: root, fwHome: home, now: () => new Date(fc.clock.now()) });
    const sched = createScheduler({ writer: w, clock: fc.clock, onFire, jitterMs: 0 });
    await sched.start();

    const slot = (n: number) => Date.parse('2026-01-05T10:05:00.000Z') + (n - 1) * 5 * MIN;
    const last = async (n: number, streamId = FLOW) => {
      await fc.advanceTo(slot(n) + 1000);
      const ev = (await fired(home, streamId)).filter((e) => e.scheduled_for === new Date(slot(n)).toISOString());
      expect(ev.length, `stream.fired rows for ${streamId} at slot ${n}`).toBe(1);
      return ev[0];
    };
    const heldBy = (e: Fired, gate: string, step: string) => {
      expect([e.outcome, (e.reason ?? '').split(':')[0]], `${step}: outcome and the gate the reason names`).toEqual([
        'held',
        gate,
      ]);
    };

    // ---- 1. a fresh flow is held by flow_disabled; a stream that is not a flow still fires ----
    heldBy(await last(1), 'flow_disabled', 'a fresh flow');
    expect((await fired(home, OTHER)).map((e) => e.outcome), 'the stream that is not a flow, slot 1').toEqual(['fired']);

    // ---- 2. enabled, the flow's fire is fired: the fire itself makes it due -------------------
    setFlowEnabled(w, root, KEY, true);
    expect((await last(2)).outcome, 'an enabled flow at Draft with a cap, slot 2').toBe('fired');

    // ---- 3. a paused Supervisor holds it ------------------------------------------------------
    setPaused(w, true);
    heldBy(await last(3), 'supervisor_paused', 'a paused Supervisor');
    setPaused(w, false);

    // ---- 4. Autopilot with a stale confirmation holds it by dial_unapproved --------------------
    let hash: string | undefined;
    try {
      setDial(w, root, home, KEY, 'autopilot');
    } catch (e) {
      const d = (e as { details?: { confirm_hash?: string } }).details;
      hash = d?.confirm_hash;
    }
    check(typeof hash === 'string', 'setDial to autopilot without a hash did not name the confirm hash');
    setDial(w, root, home, KEY, 'autopilot', hash);
    const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
    const over = join(home, 'flows', KEY);
    mkdirSync(over, { recursive: true });
    writeFileSync(
      join(over, 'config.json'),
      JSON.stringify({ ...cfg, channels: [...cfg.channels, { key: 'probe_channel', label: 'Probe', action_class: 'publish_external', placeholder: true }] }),
    );
    heldBy(await last(4), 'dial_unapproved', 'Autopilot after its channels changed');

    // ---- 5. a flow whose logic fails is held by no_engine --------------------------------------
    setDial(w, root, home, KEY, 'copilot');
    writeFileSync(join(over, 'config.json'), '{ not json');
    heldBy(await last(5), 'no_engine', 'a flow whose config cannot be read');
    rmSync(join(over, 'config.json'));

    // ---- 6. the kill switch holds it ------------------------------------------------------------
    // Engaged through the store's own connection (the one writer), the way fwd's kill switch writes it.
    (w as { transaction(fn: (tx: { run(sql: string, p: unknown[]): unknown }) => void): void }).transaction((tx) =>
      tx.run("UPDATE settings SET value = ?, updated_by = 'own_probe' WHERE key = 'kill_switch'", [
        JSON.stringify({ engaged: true, reason: 'probe' }),
      ]),
    );
    heldBy(await last(6), 'kill_switch', 'the kill switch engaged');

    await sched.stop();
    store!.close();
    store = undefined;

    // ---- 7. fwd uses the Supervisor by default ----------------------------------------------------
    const home2 = freshHome('flows-fire-fwd');
    await addStreams(home2, 'FW-C-962', [{ id: FLOW, key: KEY, cron: '* * * * *' }]);
    const port = await freePort();
    const d = spawnTs(DAEMON_BIN, ['--home', home2, '--port', String(port)], { env: { FW_HOME: home2 } });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    let first: Fired | undefined;
    await waitFor(
      async () => {
        first = (await fired(home2, FLOW)).find((e) => e.outcome !== 'missed');
        return first !== undefined;
      },
      { timeoutMs: 75000, everyMs: 500, what: 'fwd to fire the flow stream (cron every minute)' },
    );
    heldBy(first!, 'flow_disabled', 'fwd, a fresh flow');
  });
});
