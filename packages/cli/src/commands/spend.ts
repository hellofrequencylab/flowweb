// fw spend [--by agent|run|vendor|day|project]: the spend rollup, the same numbers as GET /v1/spend.
// A run whose vendor reported no cost has no spend entries: its cost prints as `unknown`, never $0.
import { SPEND_GROUPS, type SpendGroup, type SpendGroupRow } from '../client.ts';
import { EXIT, table, usd } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

/** The key column of each grouping, as the rollup names it. */
export const SPEND_KEY: Record<SpendGroup, string> = {
  agent: 'agent_id',
  run: 'run_id',
  vendor: 'vendor',
  day: 'day',
  project: 'project_id',
};

export interface SpendReport {
  by: SpendGroup;
  groups: SpendGroupRow[];
  /** usd is null when no group has a known cost. */
  total: { usd: number | null; entries: number; unknown_runs: number };
}

export function spendReport(by: SpendGroup, groups: SpendGroupRow[]): SpendReport {
  const known = groups.filter((g) => g.usd !== null);
  return {
    by,
    groups,
    total: {
      usd: known.length ? Math.round(known.reduce((s, g) => s + (g.usd ?? 0), 0) * 1e6) / 1e6 : null,
      entries: groups.reduce((s, g) => s + g.entries, 0),
      unknown_runs: groups.reduce((s, g) => s + (g.unknown_runs ?? 0), 0),
    },
  };
}

const spend: Command = {
  path: ['spend'],
  usage: `fw spend [--by ${SPEND_GROUPS.join('|')}]`,
  summary: 'Spend rollup from the recorded spend entries; a cost no vendor reported shows as unknown',
  args: [],
  options: ['by'],
  async run(ctx) {
    const by = (ctx.opts.by ?? 'agent') as SpendGroup;
    if (!SPEND_GROUPS.includes(by))
      throw Object.assign(new Error(`--by must be one of ${SPEND_GROUPS.join(', ')}`), {
        code: 'BAD_ARGUMENT',
      });
    const fn = ctx.client.spendRollup;
    if (typeof fn !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the spend rollup; the daemon package provides it',
      );
    const report = spendReport(by, await fn.call(ctx.client, { by }));
    if (ctx.json) {
      ctx.io.out(JSON.stringify(report, null, 2));
      return EXIT.OK;
    }
    if (!report.groups.length) {
      ctx.io.out('no spend recorded');
      return EXIT.OK;
    }
    const key = SPEND_KEY[by];
    const t = report.total;
    ctx.io.out(
      table([
        [by.toUpperCase(), 'COST', 'ENTRIES', 'TOKENS IN', 'TOKENS OUT', 'UNKNOWN RUNS'],
        ...report.groups.map((g) => [
          String(g[key] ?? '-'),
          usd(g.usd),
          String(g.entries),
          String(g.tokens_in),
          String(g.tokens_out),
          String(g.unknown_runs ?? 0),
        ]),
        ['total', usd(t.usd), String(t.entries), '', '', String(t.unknown_runs)],
      ]),
    );
    if (t.unknown_runs)
      ctx.io.out(
        `${t.unknown_runs} run${t.unknown_runs === 1 ? '' : 's'} reported no cost (unknown, not counted as $0)`,
      );
    return EXIT.OK;
  },
};

export const spendCommands: Command[] = [spend];
