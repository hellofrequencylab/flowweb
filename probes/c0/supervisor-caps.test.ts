// Probe c0/supervisor-caps (WS-P0-028; backlog verify_probe runtime/supervisor-caps).
// Surface: supervise(adapter, input, { onEvent?, killGraceMs? }) exported by
// packages/daemon/src/index.ts (it resolves to the run result plus cap_breach), wrapping
// createAdapter('fake') with the hang scenario (ignores SIGTERM, spawns a grandchild) and the
// over_budget scenario. The adapter SDK enforces the caps first; the supervisor is the second layer.
// Acceptance:
//   - a fake runaway process is killed within 2 s of the wall-clock cap
//   - the breach is recorded as cap_breach naming which cap (wall_clock, usd or tokens, turns)
//   - no orphan child processes remain (process listing: no live member of the vendor's process
//     group, no process with its cwd inside the workspace)
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { adapterInput, gitWorkspace, groupAlive, requireExport, sleep } from './_lib.mjs';

type Ev = Record<string, any>;
type Supervise = (
  a: unknown,
  input: unknown,
  o?: { onEvent?: (e: Ev) => void; killGraceMs?: number },
) => Promise<Record<string, any>>;

function pidsInDir(dir: string) {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) continue;
      if (readlinkSync(`/proc/${d}/cwd`).startsWith(dir)) out.push(Number(d));
    } catch {}
  }
  return out;
}

async function supervised(scenario: string, tweak: (i: Ev) => void = () => {}) {
  const supervise = (await requireExport('daemon', 'supervise', 'WS-P0-028')) as Supervise;
  const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-028')) as (n: string) => unknown;
  const ws = gitWorkspace(`sup-${scenario}`);
  const input = adapterInput({ scenario, workspace: ws.path, maxWallClockS: 2 }) as Ev;
  tweak(input);
  const events: Ev[] = [];
  const started = Date.now();
  const result = await supervise(createAdapter('fake'), input, { onEvent: (e) => events.push(e), killGraceMs: 300 });
  const ms = Date.now() - started;
  const pgid = events.find((e) => e.type === 'process' && e.phase === 'spawned')?.pgid as number | undefined;
  await sleep(300);
  expect(pgid, `${scenario}: the vendor process group is reported`).toBeTruthy();
  expect(groupAlive(pgid), `${scenario}: no live member of the vendor process group`).toBe(false);
  expect(pidsInDir(ws.path), `${scenario}: no orphan process in the run workspace`).toEqual([]);
  return { result, events, ms };
}

describe('c0/supervisor-caps', () => {
  test('wall clock: the runaway is killed within 2 s of the cap and the breach names wall_clock', async () => {
    const { result, events, ms } = await supervised('hang');
    expect(ms, 'killed within 2 s of the 2 s wall-clock cap').toBeLessThan(4000);
    expect(result.status).toBe('timeout');
    const breach = events.filter((e) => e.type === 'cap_breach');
    expect(breach.length, 'one cap_breach event').toBeGreaterThanOrEqual(1);
    expect(breach[0].cap).toBe('wall_clock');
    expect(result.cap_breach?.cap, 'the supervised result records which cap').toBe('wall_clock');
  }, 30_000);

  test('budget: the dollar or token cap is a cap_breach naming that cap', async () => {
    const { result, events } = await supervised('over_budget', (i) => {
      i.budget.max_usd = 0.01;
      i.work_order.budget.caps.max_usd = 0.01;
      i.caps.max_wall_clock_s = 30;
    });
    expect(result.status).toBe('budget_exceeded');
    const breach = events.find((e) => e.type === 'cap_breach');
    expect(['usd', 'tokens'], `cap_breach names the budget cap (${JSON.stringify(breach)})`).toContain(breach?.cap);
    expect(result.cap_breach?.cap).toBe(breach?.cap);
  }, 30_000);

  test('turns: exceeding the turn cap is a cap_breach naming turns', async () => {
    const { result, events } = await supervised('hang', (i) => {
      i.caps.max_wall_clock_s = 30;
      i.caps.max_turns = 0;
      i.budget.max_turns = 0;
    });
    const breach = events.find((e) => e.type === 'cap_breach');
    expect(breach?.cap, `cap_breach names turns (${JSON.stringify(breach)})`).toBe('turns');
    expect(result.cap_breach?.cap).toBe('turns');
    expect(result.status).not.toBe('completed');
  }, 30_000);
});
