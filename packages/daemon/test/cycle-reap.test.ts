// FW-C-045: a finished cycle leaves no vendor record behind, and a start after a crash reports each
// unfinished cycle exactly once, killing its vendor only when the group provably works in its folder.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupAlive } from '@fw/adapters';
import { openStore } from '@fw/eventlog';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { flowStream, reapOrphanCycles, runFlowCycle } from '../src/overseer/cycle.ts';
import { setFlowEnabled } from '../src/overseer/index.ts';
import { tempHome } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function home() {
  const h = tempHome();
  cleanups.push(h.cleanup);
  ensureFwHome(h.path);
  const store = openStore({ path: join(h.path, 'db', 'fw.sqlite'), lockPath: join(h.path, 'fwd.lock') });
  cleanups.unshift(() => store.close());
  const w = store.writer!;
  setFlowEnabled(w, REPO_ROOT, KEY, true);
  return { path: h.path, w, streamId: String(flowStream(REPO_ROOT, KEY)?.id) };
}

function reports(w: ReturnType<typeof home>['w']) {
  return w
    .all<{ body: string }>("SELECT body FROM status_reports WHERE kind = 'run'")
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
}

test('a cycle that finishes removes its vendor record, so a later start reaps nothing', async () => {
  const h = home();
  await runFlowCycle(
    {
      writer: h.w,
      repoRoot: REPO_ROOT,
      fwHome: h.path,
      env: { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' },
    },
    { flow: KEY, streamId: h.streamId, fireId: 'done1' },
  );
  expect(existsSync(join(h.path, 'flows', KEY, 'cycles', 'done1', 'vendor.json'))).toBe(false);
  expect(reapOrphanCycles(h.w, REPO_ROOT, h.path)).toEqual([]);
  expect(reports(h.w)).toHaveLength(1);
});

test('a start after a crash kills the cycle group, reports it failed once, and only once', async () => {
  const h = home();
  const dir = join(h.path, 'flows', KEY, 'cycles', 'crashed1');
  mkdirSync(dir, { recursive: true });
  const child = spawn('sleep', ['60'], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  const pgid = child.pid!;
  cleanups.push(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  });
  writeFileSync(
    join(dir, 'vendor.json'),
    JSON.stringify({
      pgid,
      started_at: new Date().toISOString(),
      flow: KEY,
      fire_id: 'crashed1',
      stream_id: h.streamId,
      adapter: 'fake',
    }),
  );

  expect(reapOrphanCycles(h.w, REPO_ROOT, h.path)).toEqual(['crashed1']);
  const deadline = Date.now() + 5000;
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  expect(groupAlive(pgid)).toBe(false);
  expect(existsSync(join(dir, 'vendor.json'))).toBe(false);
  const [r, ...rest] = reports(h.w);
  expect(rest).toEqual([]);
  expect(r).toMatchObject({ fire_id: 'crashed1', flow: KEY, adapter: 'fake', outcome: 'failed', drafts: 0 });
  expect(String(r!.reason)).toMatch(/^orphaned: .*killed/);

  expect(reapOrphanCycles(h.w, REPO_ROOT, h.path)).toEqual([]);
  expect(reports(h.w)).toHaveLength(1);
});

test('a recorded group that does not work in the cycle folder is never signalled', async () => {
  const h = home();
  const dir = join(h.path, 'flows', KEY, 'cycles', 'reused1');
  mkdirSync(dir, { recursive: true });
  // A live group elsewhere stands in for a group id the system handed to someone else.
  const other = spawn('sleep', ['60'], { cwd: h.path, detached: true, stdio: 'ignore' });
  other.unref();
  const pgid = other.pid!;
  cleanups.push(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  });
  writeFileSync(join(dir, 'vendor.json'), JSON.stringify({ pgid, fire_id: 'reused1', flow: KEY }));

  expect(reapOrphanCycles(h.w, REPO_ROOT, h.path)).toEqual(['reused1']);
  if (process.platform === 'linux') {
    expect(groupAlive(pgid)).toBe(true);
    expect(String(reports(h.w)[0]?.reason)).toMatch(/unverified/);
  }
});
