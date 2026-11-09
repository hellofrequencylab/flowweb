// WS-P0-025: the spend rollup shared by GET /v1/spend and `fw spend`. Seeded through the Writer:
// three runs by one agent, one of them with two spend entries (0.5 + 0.25), two with none.
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createCoreClient } from '../src/local-client.ts';
import { spendRollup } from '../src/spend.ts';
import { IDS, seed, tempHome } from './api-fixtures.ts';

const home = tempHome();
const today = new Date().toISOString().slice(0, 10);

beforeAll(() => seed(home.path));
afterAll(() => home.cleanup());

function read<T>(fn: (r: ReturnType<ReturnType<typeof openStore>['reader']>) => T): T {
  const store = openStore({ path: join(home.path, 'db', 'fw.sqlite'), readonly: true });
  try {
    return fn(store.reader());
  } finally {
    store.close();
  }
}

describe('spendRollup', () => {
  test('without unknown it reports spend entries only, as the API always has', () => {
    const rows = read((r) => spendRollup(r, { by: 'agent' }));
    expect(rows).toEqual([
      expect.objectContaining({ agent_id: 'agt_work0001', usd: 0.75, entries: 2, tokens_in: 150 }),
    ]);
    expect(rows[0]).not.toHaveProperty('unknown_runs');
  });

  test('the rollup equals the SQL sum of spend_entries for every grouping', () => {
    const total = read((r) => r.get<{ usd: number }>('SELECT SUM(usd) AS usd FROM spend_entries')!.usd);
    for (const by of ['project', 'agent', 'run', 'vendor', 'day'] as const) {
      const rows = read((r) => spendRollup(r, { by, unknown: true }));
      const sum = rows.reduce((s, g) => s + (g.usd ?? 0), 0);
      expect(sum, by).toBeCloseTo(total, 9);
    }
  });

  test('a run with no spend entries is unknown, never zero', () => {
    const byRun = read((r) => spendRollup(r, { by: 'run', unknown: true }));
    expect(byRun).toEqual([
      expect.objectContaining({ run_id: IDS.run, usd: 0.75, entries: 2, unknown_runs: 0 }),
      expect.objectContaining({ run_id: IDS.run2, usd: null, entries: 0, unknown_runs: 1 }),
      expect.objectContaining({ run_id: IDS.orphan, usd: null, entries: 0, unknown_runs: 1 }),
    ]);
    const byAgent = read((r) => spendRollup(r, { by: 'agent', unknown: true }));
    expect(byAgent).toEqual([
      expect.objectContaining({ agent_id: 'agt_work0001', usd: 0.75, unknown_runs: 2 }),
    ]);
  });

  test('by day groups spend by its timestamp and unknown runs by the day they were queued', () => {
    const byDay = read((r) => spendRollup(r, { by: 'day', unknown: true }));
    expect(byDay[0]).toMatchObject({ day: today, usd: 0.75, unknown_runs: 0 });
    expect(byDay.slice(1)).toEqual([
      expect.objectContaining({ day: '2026-01-02', usd: null, unknown_runs: 1 }),
      expect.objectContaining({ day: '2026-01-03', usd: null, unknown_runs: 1 }),
    ]);
  });

  test('from and to filter by timestamp; limit and offset page', () => {
    expect(read((r) => spendRollup(r, { by: 'vendor', from: '2999-01-01T00:00:00Z' }))).toEqual([]);
    const page = read((r) => spendRollup(r, { by: 'run', unknown: true, limit: 1, offset: 1 }));
    expect(page.map((g) => g.run_id)).toEqual([IDS.run2]);
  });
});

describe('the core client spendRollup (fw spend)', () => {
  test('serves the rollup with unknown runs and refuses an unknown grouping', async () => {
    const client = createCoreClient({ home: home.path, repoDir: home.path });
    try {
      const rows = await client.spendRollup({ by: 'run' });
      expect(rows.map((g) => [g.run_id, g.usd])).toEqual([
        [IDS.run, 0.75],
        [IDS.run2, null],
        [IDS.orphan, null],
      ]);
      await expect(client.spendRollup({ by: 'moon' })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    } finally {
      client.close();
    }
  });
});
