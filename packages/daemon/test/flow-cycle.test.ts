// FW-C-038: turning a flow on registers its stream once, and one cycle on the fake adapter writes
// drafts that wait for the Owner, the flow's spend and one run report. Nothing is sent.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { flowStream, runFlowCycle } from '../src/overseer/cycle.ts';
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
