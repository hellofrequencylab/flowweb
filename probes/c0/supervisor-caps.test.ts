// Probe c0/supervisor-caps (WS-P0-028; backlog verify_probe runtime/supervisor-caps).
// Surface: supervise(adapter, input, { onEvent? }) exported by packages/daemon/src/index.ts, wrapping
// createAdapter('fake') (runaway and cost_overrun scenarios). It resolves to the run result.
// Acceptance:
//   - a fake runaway process is killed within 2 s of the wall-clock cap
//   - the breach is recorded as cap_breach naming which cap (wall_clock, usd, turns)
//   - no orphan child processes remain (no process has its cwd inside the workspace)
import { readdirSync, readlinkSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { adapterInput, requireExport, sleep, tmpDir } from './_lib.mjs';

type Ev = Record<string, unknown>;
type Supervise = (a: unknown, input: unknown, o?: { onEvent?: (e: Ev) => void }) => Promise<Record<string, unknown>>;

function pidsInDir(dir: string) {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (readlinkSync(`/proc/${d}/cwd`).startsWith(dir)) out.push(Number(d));
    } catch {}
  }
  return out;
}

describe('c0/supervisor-caps', () => {
  test('wall-clock and dollar caps kill the process tree and record cap_breach', async () => {
    const supervise = (await requireExport('daemon', 'supervise', 'WS-P0-028')) as Supervise;
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-028')) as (n: string) => unknown;

    const ws = tmpDir('sup-run');
    const events: Ev[] = [];
    const started = Date.now();
    await supervise(createAdapter('fake'), adapterInput({ scenario: 'runaway', workspace: ws, maxWallClockS: 2 }), {
      onEvent: (e) => events.push(e),
    });
    const ms = Date.now() - started;
    expect(ms, 'killed within 2 s of the 2 s wall-clock cap').toBeLessThan(4000);
    const breach = events.find((e) => e.type === 'cap_breach');
    expect(breach, 'a cap_breach event').toBeTruthy();
    expect(JSON.stringify(breach)).toMatch(/wall_clock/);
    await sleep(300);
    expect(pidsInDir(ws), 'no orphan process in the run workspace').toEqual([]);

    const ws2 = tmpDir('sup-usd');
    const ev2: Ev[] = [];
    await supervise(createAdapter('fake'), adapterInput({ scenario: 'cost_overrun', workspace: ws2, maxUsd: 0.01 }), {
      onEvent: (e) => ev2.push(e),
    });
    const usd = ev2.find((e) => e.type === 'cap_breach');
    expect(usd, 'a cap_breach event for the dollar cap').toBeTruthy();
    expect(JSON.stringify(usd)).toMatch(/usd/);
    await sleep(300);
    expect(pidsInDir(ws2)).toEqual([]);
  }, 60_000);
});
