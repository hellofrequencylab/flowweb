// fwd as a real process: the single-writer lock (a second fwd exits 1), a clean SIGTERM stop, and
// crash recovery (kill -9 mid-run, restart: the run is failed, its lease released, nothing re-runs).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterAll, describe, expect, test } from 'vitest';
import { BIN, call, FUTURE, IDS, seed, spawnTs, tempHome, withWriter } from './api-fixtures.ts';

const CRASH_CHILD = resolve(import.meta.dirname, 'fixtures/crash-child.ts');
const homes: Array<{ cleanup: () => void }> = [];
afterAll(() => {
  for (const h of homes) h.cleanup();
});

function home(): string {
  const h = tempHome();
  homes.push(h);
  return h.path;
}

function readDb<T>(fwHome: string, fn: (r: ReturnType<ReturnType<typeof openStore>['reader']>) => T): T {
  const s = openStore({ path: join(fwHome, 'db', 'fw.sqlite'), readonly: true });
  try {
    return fn(s.reader());
  } finally {
    s.close();
  }
}

async function startBin(fwHome: string, extra: string[] = []) {
  const child = spawnTs(BIN, ['--home', fwHome, '--port', '0', ...extra]);
  const m = await child.waitFor(/listening on http:\/\/127\.0\.0\.1:(\d+)\/v1/);
  return { child, port: Number(m[1]) };
}

describe('fwd process', () => {
  test('prints the pairing code, writes cli.token, and stops cleanly on SIGTERM', async () => {
    const h = home();
    const { child, port } = await startBin(h);
    await child.waitFor(/Pairing code: [0-9A-Z]{4}-[0-9A-Z]{4}/);
    const token = readFileSync(join(h, 'pairing', 'cli.token'), 'utf8').trim();
    const res = await call(port, 'GET', '/v1/status', { headers: { authorization: `Bearer ${token}` } });
    expect(res.json.data.daemon).toBe('up');
    child.proc.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    const types = readDb(h, (r) => r.all<{ type: string }>('SELECT type FROM events ORDER BY seq')).map(
      (e) => e.type,
    );
    expect(types).toEqual(['system.started', 'reconciler.completed', 'system.stopped']);
  });

  test('a second fwd on the same FW_HOME fails fast with exit 1 and the lock message', async () => {
    const h = home();
    const first = await startBin(h);
    const second = spawnTs(BIN, ['--home', h, '--port', '0']);
    expect(await second.exited).toBe(1);
    expect(second.out()).toMatch(/another fwd is already running for FW_HOME=.*writer lock .*fwd\.lock/);
    first.child.proc.kill('SIGTERM');
    expect(await first.child.exited).toBe(0);
  });

  test('refuses a non-loopback --host', async () => {
    const c = spawnTs(BIN, ['--home', home(), '--host', '0.0.0.0']);
    expect(await c.exited).toBe(1);
    expect(c.out()).toContain('fixed to 127.0.0.1');
  });

  test('kill -9 mid-run, restart: the run is failed once, its lease released, and it is not run again', async () => {
    const h = home();
    seed(h);
    // A fresh queued run with a live lease, which the crash child starts.
    const runId = 'run_crash0001';
    withWriter(h, (w) => {
      w.run(
        `INSERT INTO leases(id, resource_kind, resource_key, holder_agent_id, run_id, fence_token, expires_at)
         VALUES ('lse_crash0001', 'worktree', 'wt-crash', 'agt_work0001', ?, 1, ?)`,
        [runId, FUTURE],
      );
      w.run(
        `INSERT INTO runs(id, work_order_id, project_id, stream_id, agent_id, attempt, adapter_name, adapter_vendor, lease_id)
         VALUES (?, ?, ?, 'stm_test0001', 'agt_work0001', 9, 'fake', 'local', 'lse_crash0001')`,
        [runId, IDS.wo, IDS.project],
      );
    });

    const crash = spawnTs(CRASH_CHILD, [h, runId]);
    await crash.waitFor(/RUNNING \d+/);
    expect(
      readDb(h, (r) => r.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', [runId])),
    ).toEqual({
      status: 'running',
    });
    crash.proc.kill('SIGKILL');
    await crash.exited;

    // The lock file of the dead process is stale and taken over.
    const { child, port } = await startBin(h, []);
    const token = readFileSync(join(h, 'pairing', 'cli.token'), 'utf8').trim();
    const auth = { authorization: `Bearer ${token}` };
    const run = (await call(port, 'GET', `/v1/runs/${runId}`, { headers: auth })).json.data;
    expect(run.status).toBe('failed');
    expect(run.failure_class).toBe('killed');
    child.proc.kill('SIGTERM');
    expect(await child.exited).toBe(0);

    // A second restart has nothing left to reconcile for this run.
    const again = await startBin(h, []);
    again.child.proc.kill('SIGTERM');
    expect(await again.child.exited).toBe(0);

    readDb(h, (r) => {
      const count = (type: string) =>
        r.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE type = ? AND run_id = ?', [type, runId])!
          .n;
      expect(count('run.started')).toBe(1); // started once, never again
      expect(count('run.failed')).toBe(1); // failed once, by the first restart
      expect(r.get('SELECT status FROM leases WHERE id = ?', ['lse_crash0001'])).toEqual({
        status: 'released',
      });
      expect(r.get('SELECT COUNT(*) AS n FROM runs WHERE work_order_id = ?', [IDS.wo])).toEqual({ n: 4 });
      const stops = r.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'system.stopped'");
      expect(stops).toHaveLength(2); // the killed process never wrote one
      expect(r.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', ['system.started'])).toEqual({ n: 3 });
    });
  });
});
