// FW-C-038: turning a flow on registers its stream once, and one cycle on the fake adapter writes
// drafts that wait for the Owner, the flow's spend and one run report. Nothing is sent.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { briefProject } from '@fw/ledger';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { saveHunts } from '../src/flows/hunts.ts';
import { addFlowSpend, flowEngine, flowStream, runFlowCycle } from '../src/overseer/cycle.ts';
import { handOff, setDial, setFlowEnabled } from '../src/overseer/index.ts';
import { tempHome, withWriter } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test('turning the flow on registers its stream once', () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  const id = String(flowStream(REPO_ROOT, KEY)?.id);
  withWriter(h.path, (w) => {
    setFlowEnabled(w, REPO_ROOT, KEY, true);
    setFlowEnabled(w, REPO_ROOT, KEY, false);
    setFlowEnabled(w, REPO_ROOT, KEY, true);
    expect(w.all('SELECT key FROM streams WHERE id = ?', [id])).toEqual([{ key: KEY }]);
  });
});

test('one cycle on the fake adapter writes drafts, spend and a run report', async () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  ensureFwHome(h.path);
  const store = openStore({ path: join(h.path, 'db', 'fw.sqlite'), lockPath: join(h.path, 'fwd.lock') });
  cleanups.unshift(() => store.close());
  const w = store.writer!;
  setFlowEnabled(w, REPO_ROOT, KEY, true);
  const streamId = String(flowStream(REPO_ROOT, KEY)?.id);
  const env = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' };
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: h.path, env },
    { flow: KEY, streamId, fireId: 'fire1' },
  );

  const dir = join(h.path, 'flows', KEY, 'drafts');
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(JSON.parse(readFileSync(join(dir, f), 'utf8'))).toMatchObject({
      flow: KEY,
      fire_id: 'fire1',
      status: 'waiting_for_owner',
    });
  }
  const spend = w.get<{ usd: number }>('SELECT sum(usd) AS usd FROM spend_entries WHERE stream_id = ?', [
    streamId,
  ]);
  expect(spend?.usd).toBeGreaterThan(0);
  const state = JSON.parse(readFileSync(join(h.path, 'flows', KEY, 'state.json'), 'utf8'));
  expect(state.spend.usd).toBeGreaterThan(0);
  const rpt = w.get<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'");
  expect(JSON.parse(rpt!.body)).toMatchObject({ adapter: 'fake', outcome: 'drafted', drafts: files.length });
  expect(existsSync(join(h.path, 'outbox'))).toBe(false);
});

test('a cycle that cannot start ends in a failed report, not a throw', async () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  ensureFwHome(h.path);
  const store = openStore({ path: join(h.path, 'db', 'fw.sqlite'), lockPath: join(h.path, 'fwd.lock') });
  cleanups.unshift(() => store.close());
  const w = store.writer!;
  setFlowEnabled(w, REPO_ROOT, KEY, true);
  const streamId = String(flowStream(REPO_ROOT, KEY)?.id);
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: h.path, env: { FW_VENDOR: 'no-such-vendor' } },
    { flow: KEY, streamId, fireId: 'fire2' },
  );
  const rpt = w.get<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'");
  expect(JSON.parse(rpt!.body)).toMatchObject({ outcome: 'failed', drafts: 0 });
});

// A stub adapter that records what the cycle hands it and ends without drafts.
function recorder() {
  const seen: {
    name?: string;
    options?: unknown;
    input?: unknown;
    credentialEnv?: Record<string, string> | undefined;
  } = {};
  const factory = (name: string, options: unknown) => {
    seen.name = name;
    seen.options = options;
    return {
      start: (input: unknown, opts: { credentialEnv?: Record<string, string> }) => {
        seen.input = input;
        seen.credentialEnv = opts.credentialEnv;
        return {
          events: (async function* () {})(),
          result: Promise.resolve({ status: 'completed', turns: 0, cost: { usd: 0 } }),
        };
      },
    };
  };
  return { seen, factory: factory as never };
}

function cycleHome() {
  const h = tempHome();
  cleanups.push(h.cleanup);
  ensureFwHome(h.path);
  const store = openStore({ path: join(h.path, 'db', 'fw.sqlite'), lockPath: join(h.path, 'fwd.lock') });
  cleanups.unshift(() => store.close());
  setFlowEnabled(store.writer!, REPO_ROOT, KEY, true);
  return { home: h.path, w: store.writer!, streamId: String(flowStream(REPO_ROOT, KEY)?.id) };
}

test("the flow's engine picks the adapter and its sign-in lane", async () => {
  expect(flowEngine(REPO_ROOT, KEY)).toEqual({ adapter: 'codex', auth: 'signin' });
  const { home, w, streamId } = cycleHome();
  const r = recorder();
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: home, env: {}, keychain: false, adapterFactory: r.factory },
    { flow: KEY, streamId, fireId: 'fire3' },
  );
  expect(r.seen.name).toBe('codex');
  // The order lets the agent write drafts.json: nothing it must write is forbidden.
  const scope = (r.seen.input as { work_order: { scope: { touches: string[]; forbidden: string[] } } })
    .work_order.scope;
  expect(scope.touches).toContain('drafts.json');
  expect(scope.forbidden.some((g) => g === '**/*' || g === '**' || g === 'drafts.json')).toBe(false);
  // Without hunts or network the order asks for templates only, names one output, and never says to
  // find leads (run 5 on the Owner's Mac refused an order that contradicted itself).
  const wo = (r.seen.input as { work_order: { goal: string; constraints: { notes: string[] } } }).work_order;
  expect(scope.touches).toEqual(['drafts.json']);
  expect(wo.goal).not.toMatch(/find leads/i);
  expect(wo.goal).toContain('template invite per funnel');
  expect(wo.constraints.notes[0]).toBe('This is a flow cycle: write drafts.json only, and commit nothing.');
  expect((r.seen.input as { workspace: { base_commit: string } }).workspace.base_commit).toMatch(/^0+$/);
  // Codex refuses to start outside a git repository, so the cycle folder is one.
  expect(existsSync(join(home, 'flows', KEY, 'cycles', 'fire3', '.git'))).toBe(true);
  expect(r.seen.options).toMatchObject({ codex: { auth: 'signin' }, env: { FW_CODEX_AUTH: 'signin' } });
  const rpt = w.get<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'");
  expect(JSON.parse(rpt!.body)).toMatchObject({ adapter: 'codex', outcome: 'dry' });
});

test('a cycle loads the sign-in token the same way a ledger run does', async () => {
  const { home, w, streamId } = cycleHome();
  mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'creds', 'crd_claude0002'), 'fake-signin-token', { mode: 0o600 });
  const r = recorder();
  await runFlowCycle(
    {
      writer: w,
      repoRoot: REPO_ROOT,
      fwHome: home,
      env: { FW_VENDOR: 'claude', FW_CLAUDE_AUTH: 'signin' },
      keychain: false,
      adapterFactory: r.factory,
    },
    { flow: KEY, streamId, fireId: 'fire4' },
  );
  expect(r.seen.credentialEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-signin-token' });
  expect((r.seen.input as { credentials_handle: { handle_id: string } }).credentials_handle.handle_id).toBe(
    'crd_claude0002',
  );
});

test('the agent gets the flow files and the Owner brief in its own folder', async () => {
  const { home, w, streamId } = cycleHome();
  const projectId = String(flowStream(REPO_ROOT, KEY)?.project_id);
  briefProject(w, projectId, {
    what: 'Local Circles',
    who: 'Neighbors',
    voice: 'Warm and plain',
    never: 'Never send anything',
    done: 'A host per area',
  });
  mkdirSync(join(home, 'flows', KEY), { recursive: true });
  writeFileSync(join(home, 'flows', KEY, 'config.json'), '{"override":true}\n');
  const r = recorder();
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: home, env: {}, keychain: false, adapterFactory: r.factory },
    { flow: KEY, streamId, fireId: 'fire5' },
  );
  const dir = join(home, 'flows', KEY, 'cycles', 'fire5');
  expect(existsSync(join(dir, 'README.md'))).toBe(true);
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{"override":true}\n');
  const order = (r.seen.input as { work_order: { constraints: { style?: string[]; notes: string[] } } })
    .work_order;
  expect(order.constraints.style).toEqual(["Voice, from the Owner's project brief: Warm and plain"]);
  expect(order.constraints.notes).toContain('What the agents must never do on it: Never send anything');
});

test('spend adds up within a period and starts again when the period ends', () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  const d = { fwHome: h.path, repoRoot: REPO_ROOT };
  const state = () => JSON.parse(readFileSync(join(h.path, 'flows', KEY, 'state.json'), 'utf8')).spend;
  const t0 = new Date('2026-11-01T00:00:00Z');
  addFlowSpend(d, KEY, 1, 10, t0);
  addFlowSpend(d, KEY, 2, 5, new Date('2026-11-03T00:00:00Z'));
  expect(state()).toEqual({ period_start: t0.toISOString(), usd: 3, turns: 15 });
  const t1 = new Date('2026-11-09T00:00:00Z');
  addFlowSpend(d, KEY, 0.5, 1, t1);
  expect(state()).toEqual({ period_start: t1.toISOString(), usd: 0.5, turns: 1 });
});

test('at confirmed Autopilot a cycle hands its drafts to the outbox, once', async () => {
  const { home, w, streamId } = cycleHome();
  let hash: string | undefined;
  try {
    setDial(w, REPO_ROOT, home, KEY, 'autopilot');
  } catch (e) {
    hash = (e as { details?: { confirm_hash?: string } }).details?.confirm_hash;
  }
  setDial(w, REPO_ROOT, home, KEY, 'autopilot', hash);
  const env = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' };
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: home, env },
    { flow: KEY, streamId, fireId: 'fire6' },
  );
  const outbox = join(home, 'outbox', KEY);
  const files = readdirSync(outbox).filter((f) => f.endsWith('.json'));
  expect(files.length).toBeGreaterThan(0);
  const drafts = join(home, 'flows', KEY, 'drafts');
  for (const f of readdirSync(drafts))
    expect(JSON.parse(readFileSync(join(drafts, f), 'utf8')).status).toBe('handed_off');
  // A sending app takes a file; handing the same item off again must not write it back.
  rmSync(join(outbox, files[0]!));
  const id = files[0]!.replace(/\.json$/, '');
  const again = handOff({
    writer: w,
    repoRoot: REPO_ROOT,
    fwHome: home,
    flow: KEY,
    item: { id, channel: 'founder_email', body: 'x' },
  });
  expect(again.outcome).toBe('queued');
  expect(existsSync(join(outbox, files[0]!))).toBe(false);
});

test('aborting a cycle kills the vendor and still writes a report', async () => {
  const { home, w, streamId } = cycleHome();
  let killed: string | undefined;
  let finish: (r: unknown) => void = () => {};
  const factory = (() => ({
    start: () => ({
      events: (async function* () {})(),
      result: new Promise((ok) => {
        finish = ok;
      }),
      kill: async (why: string) => {
        killed = why;
        finish({ status: 'killed', summary: why, turns: 0, cost: { usd: 0 } });
      },
    }),
  })) as never;
  const ac = new AbortController();
  const done = runFlowCycle(
    {
      writer: w,
      repoRoot: REPO_ROOT,
      fwHome: home,
      env: {},
      keychain: false,
      adapterFactory: factory,
      signal: ac.signal,
    },
    { flow: KEY, streamId, fireId: 'fire7' },
  );
  await new Promise((ok) => setTimeout(ok, 20));
  ac.abort('fwd stopping');
  await done;
  expect(killed).toMatch(/interrupted: fwd stopping/);
  const rpt = w.get<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'");
  expect(JSON.parse(rpt!.body)).toMatchObject({ outcome: 'failed', reason: 'stopped by fwd: fwd stopping' });
});

test('drafts written without a named artifact still count (a cycle commits nothing)', async () => {
  const { home, w, streamId } = cycleHome();
  const dir = join(home, 'flows', KEY, 'cycles', 'fire8');
  const factory = (() => ({
    start: () => {
      writeFileSync(
        join(dir, 'drafts.json'),
        JSON.stringify({ drafts: [{ id: 'a', send_via: 'founder_email', body: 'Hello' }] }),
      );
      return {
        events: (async function* () {})(),
        result: Promise.resolve({ status: 'failed', turns: 1, cost: { usd: 0.01 } }),
        meta: Promise.resolve({ failure_class: 'no_artifact' }),
      };
    },
  })) as never;
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: home, env: {}, keychain: false, adapterFactory: factory },
    { flow: KEY, streamId, fireId: 'fire8' },
  );
  const rpt = w.get<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'");
  expect(JSON.parse(rpt!.body)).toMatchObject({ outcome: 'drafted', drafts: 1 });
});

/** A stub adapter that writes the given drafts.json into the cycle folder and finishes. */
function writesDrafts(dir: string, drafts: unknown[]) {
  return (() => ({
    start: () => {
      writeFileSync(join(dir, 'drafts.json'), JSON.stringify({ drafts }));
      return {
        events: (async function* () {})(),
        result: Promise.resolve({ status: 'completed', turns: 1, cost: { usd: 0.01 } }),
      };
    },
  })) as never;
}

test('at Autopilot a template or a draft with no lead is never handed off', async () => {
  const { home, w, streamId } = cycleHome();
  let hash: string | undefined;
  try {
    setDial(w, REPO_ROOT, home, KEY, 'autopilot');
  } catch (e) {
    hash = (e as { details?: { confirm_hash?: string } }).details?.confirm_hash;
  }
  setDial(w, REPO_ROOT, home, KEY, 'autopilot', hash);
  const factory = writesDrafts(join(home, 'flows', KEY, 'cycles', 'fire9'), [
    { id: 't', lead_id: 'template:host', send_via: 'founder_email', body: 'Template' },
    { id: 'n', send_via: 'founder_email', body: 'Nobody' },
    { id: 'a', lead_id: 'lead-1', send_via: 'founder_email', body: 'Addressed' },
  ]);
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: home, env: {}, keychain: false, adapterFactory: factory },
    { flow: KEY, streamId, fireId: 'fire9' },
  );
  const read = (id: string) =>
    JSON.parse(readFileSync(join(home, 'flows', KEY, 'drafts', `fire9-${id}.json`), 'utf8'));
  expect(read('t')).toMatchObject({ status: 'waiting_for_owner', held: 'template' });
  expect(read('n')).toMatchObject({ status: 'waiting_for_owner', held: 'no_recipient' });
  expect(read('a')).toMatchObject({ status: 'handed_off' });
  expect(readdirSync(join(home, 'outbox', KEY))).toEqual(['fire9-a.json']);
});

test('a hunt cycle ignores drafts.json, so every message goes through the hunt screen', async () => {
  const { home, w, streamId } = cycleHome();
  saveHunts(home, [
    {
      id: 'h1',
      looking_for: 'yoga',
      region: 'north-county-sd',
      areas: [],
      links: [],
      every_days: 7,
      max_sends: 5,
      build: false,
      enabled: true,
      requested_at: new Date().toISOString(),
    } as never,
  ]);
  const r = recorder();
  const dir = join(home, 'flows', KEY, 'cycles', 'fire10');
  const factory = ((name: string, options: unknown) => {
    const inner = (
      writesDrafts(dir, [{ id: 'x', lead_id: 'lead-1', send_via: 'founder_email', body: 'Unscreened' }]) as (
        n: string,
        o: unknown,
      ) => { start: (i: unknown, o: unknown) => unknown }
    )(name, options);
    return {
      start: (i: unknown, o: unknown) => {
        r.seen.input = i;
        return inner.start(i, o);
      },
    };
  }) as never;
  await runFlowCycle(
    { writer: w, repoRoot: REPO_ROOT, fwHome: home, env: {}, keychain: false, adapterFactory: factory },
    { flow: KEY, streamId, fireId: 'fire10' },
  );
  const goal = (r.seen.input as { work_order: { goal: string } }).work_order.goal;
  expect(goal).toContain('{"drafts":[]}');
  const out = join(home, 'flows', KEY, 'drafts');
  const files = existsSync(out) ? readdirSync(out) : [];
  expect(files.filter((f) => f.startsWith('fire10-x'))).toEqual([]);
  const rpt = w.get<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'");
  expect(JSON.parse(rpt!.body)).toMatchObject({ outcome: 'dry', drafts: 0 });
});

test("the Owner's config override picks the engine", () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  mkdirSync(join(h.path, 'flows', KEY), { recursive: true });
  writeFileSync(
    join(h.path, 'flows', KEY, 'config.json'),
    JSON.stringify({ engine: { adapter: 'claude', auth: 'signin' } }),
  );
  expect(flowEngine(REPO_ROOT, KEY, h.path)).toEqual({ adapter: 'claude', auth: 'signin' });
  expect(flowEngine(REPO_ROOT, KEY)).toEqual({ adapter: 'codex', auth: 'signin' });
});
