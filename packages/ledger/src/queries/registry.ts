// The query registry (FW-C-023): named, read-only, parameterised SQL whose results a report may cite as
// `[q:<id>]`. Every query takes :project, :from and :to (ISO timestamps, from inclusive, to exclusive),
// returns numeric columns, and is hashed so a reader can tell a recompute saw the same rows.
import { canonicalJson, type Reader, sha256Hex } from '@fw/eventlog';
import { LedgerError } from '../errors.ts';

export interface RegisteredQuery {
  id: string;
  title: string;
  sql: string;
}

export interface QueryParams {
  project: string;
  from: string;
  to: string;
}

export interface QueryResult {
  id: string;
  rows: Record<string, unknown>[];
  result_hash: string;
}

/** Events that describe work, not the digest describing it. */
const WORK_EVENTS = `project_id = :project AND ts >= :from AND ts < :to AND type NOT LIKE 'digest.%'`;

export const QUERIES: readonly RegisteredQuery[] = [
  {
    id: 'activity',
    title: 'What happened in the period',
    sql: `SELECT
        count(*) AS events,
        count(*) FILTER (WHERE type = 'ledger.row_created') AS rows_created,
        count(*) FILTER (WHERE type = 'ledger.row_status_changed' AND json_extract(payload, '$.to') = 'done') AS rows_done,
        count(*) FILTER (WHERE type = 'run.succeeded') AS runs_succeeded,
        count(*) FILTER (WHERE type = 'run.failed') AS runs_failed
      FROM events WHERE ${WORK_EVENTS}`,
  },
  {
    id: 'row_status',
    title: 'Ledger rows by status now',
    sql: `SELECT
        count(*) FILTER (WHERE status IN ('open','ready')) AS waiting,
        count(*) FILTER (WHERE status IN ('claimed','running','verifying','awaiting_approval','merging','watching')) AS in_flight,
        count(*) FILTER (WHERE status = 'blocked') AS blocked,
        count(*) FILTER (WHERE status = 'regressed') AS regressed,
        count(*) FILTER (WHERE status = 'done') AS done
      FROM ledger_rows WHERE project_id = :project AND :from <= :to`,
  },
  {
    id: 'spend',
    title: 'Spend recorded in the period',
    sql: `SELECT round(coalesce(sum(usd), 0), 2) AS usd,
        coalesce(sum(tokens_in + tokens_out), 0) AS tokens
      FROM spend_entries WHERE project_id = :project AND ts >= :from AND ts < :to`,
  },
  {
    id: 'wip',
    title: 'Work in progress against the project limit',
    sql: `SELECT
        (SELECT count(*) FROM ledger_rows WHERE project_id = :project
           AND status IN ('claimed','running','verifying','awaiting_approval','merging','watching')) AS active,
        wip_limit AS wip_limit
      FROM projects WHERE id = :project AND :from <= :to`,
  },
];

const BY_ID = new Map(QUERIES.map((q) => [q.id, q]));

export function findQuery(id: string): RegisteredQuery | undefined {
  return BY_ID.get(id);
}

/** Runs one registered query. Unknown ids are refused; the SQL is never taken from the caller. */
export function runQuery(r: Reader, id: string, params: QueryParams): QueryResult {
  const q = BY_ID.get(id);
  if (!q) throw new LedgerError('BAD_ARGUMENT', `unknown query ${id}`);
  const rows = r.all<Record<string, unknown>>(q.sql, {
    project: params.project,
    from: params.from,
    to: params.to,
  });
  return { id, rows, result_hash: sha256Hex(canonicalJson(rows)) };
}
