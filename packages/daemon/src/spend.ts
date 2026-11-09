// The spend rollup over spend_entries, shared by `GET /v1/spend` and `fw spend`. One SQL builder so
// the API and the CLI print the same numbers. Decision 32: a run whose vendor reported no cost has no
// spend entries, and its cost is unknown, never zero. With `unknown: true` such runs are counted per
// group (`unknown_runs`), and a group made only of them is listed with `usd: null`.
import type { Reader } from '@fw/eventlog';

/** Group key -> [column name in the result, expression over spend_entries, expression over runs]. */
const GROUPS = {
  project: ['project_id', 'project_id', 'project_id'],
  agent: ['agent_id', 'agent_id', 'agent_id'],
  run: ['run_id', 'run_id', 'id'],
  vendor: ['vendor', 'vendor', 'adapter_vendor'],
  day: ['day', 'substr(ts, 1, 10)', 'substr(queued_at, 1, 10)'],
} as const;

export type SpendGroup = keyof typeof GROUPS;
export const SPEND_GROUP_NAMES = Object.keys(GROUPS) as SpendGroup[];

export interface SpendQuery {
  by: SpendGroup;
  /** ISO timestamps: spend entries (and, with `unknown`, runs queued) at or after `from`, before `to`. */
  from?: string | null;
  to?: string | null;
  /** Also count runs with no spend entries (cost unknown). Off for the API, which reports entries only. */
  unknown?: boolean;
  limit?: number;
  offset?: number;
}

/** One group. The key column is named after the group (`agent_id`, `run_id`, `vendor`, `day`, ...). */
export interface SpendRow {
  [key: string]: string | number | null;
  /** Rounded to 6 places; null when the group has no spend entries (cost unknown). */
  usd: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  entries: number;
  first_ts: string | null;
  last_ts: string | null;
}

/** The spend rollup grouped by `q.by`, largest spend first, unknown groups last. */
export function spendRollup(r: Reader, q: SpendQuery): (SpendRow & { unknown_runs?: number })[] {
  const [col, spendExpr, runExpr] = GROUPS[q.by];
  const params = {
    from: q.from ?? null,
    to: q.to ?? null,
    limit: q.limit ?? -1,
    offset: q.offset ?? 0,
  };
  const known = `SELECT ${spendExpr} AS ${col}, ROUND(SUM(usd), 6) AS usd, SUM(tokens_in) AS tokens_in,
         SUM(tokens_out) AS tokens_out, SUM(tokens_cached) AS tokens_cached, COUNT(*) AS entries,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM spend_entries
   WHERE (@from IS NULL OR ts >= @from) AND (@to IS NULL OR ts < @to)
   GROUP BY ${spendExpr}`;
  if (!q.unknown)
    return r.all<SpendRow>(`${known} ORDER BY usd DESC, ${col} LIMIT @limit OFFSET @offset`, params);
  return r.all<SpendRow & { unknown_runs: number }>(
    `WITH k AS (${known}),
     u AS (SELECT ${runExpr} AS ${col}, COUNT(*) AS n FROM runs
            WHERE NOT EXISTS (SELECT 1 FROM spend_entries s WHERE s.run_id = runs.id)
              AND (@from IS NULL OR queued_at >= @from) AND (@to IS NULL OR queued_at < @to)
            GROUP BY ${runExpr})
     SELECT * FROM (
       SELECT k.*, COALESCE((SELECT n FROM u WHERE u.${col} IS k.${col}), 0) AS unknown_runs FROM k
       UNION ALL
       SELECT u.${col}, NULL, 0, 0, 0, 0, NULL, NULL, u.n FROM u
        WHERE NOT EXISTS (SELECT 1 FROM k WHERE k.${col} IS u.${col}))
     ORDER BY usd DESC, ${col} LIMIT @limit OFFSET @offset`,
    params,
  );
}
