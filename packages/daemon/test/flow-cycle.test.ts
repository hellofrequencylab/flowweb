// FW-C-038: turning a flow on registers its stream once, and one cycle on the fake adapter writes
// drafts that wait for the Owner, the flow's spend and one run report. Nothing is sent.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { flowEngine, flowStream, runFlowCycle } from '../src/overseer/cycle.ts';
import { setFlowEnabled } from '../src/overseer/index.ts';
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
