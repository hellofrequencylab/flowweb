// Row shaping for the API: JSON columns returned parsed, derived read-only fields added.
// Field names are the SQLite column names, unchanged (LOCAL-API-V1.md, Transport).
import { rowCodeOf } from './codes.ts';
import { evidenceView } from './evidence-view.ts';

type Row = Record<string, unknown>;

/** JSON columns per table (every column schema.core.sql checks with json_valid). */
export const JSON_COLUMNS = {
  projects: [],
  agents: ['rule_of_two_flags'],
  streams: ['definition'],
  ledger_rows: ['links', 'depends_on', 'probe_spec', 'probe_expected'],
  work_orders: ['body'],
  runs: ['result'],
  evidence_bundles: ['body'],
  approvals: ['request', 'response'],
  decision_cards: ['body', 'answer'],
  status_reports: ['body'],
  budgets: ['body'],
  events: ['payload'],
  settings: ['value'],
} as const satisfies Record<string, readonly string[]>;

export function parseJsonColumns<T extends Row>(row: T, columns: readonly string[]): T {
  const out: Row = { ...row };
  for (const c of columns) {
    const v = out[c];
    if (typeof v === 'string') {
      try {
        out[c] = JSON.parse(v);
      } catch {
        // The schema checks json_valid on write, so this cannot happen; leave the text as stored.
      }
    }
  }
  return out as T;
}

export function ledgerRow(row: Row): Row {
  return { ...parseJsonColumns(row, JSON_COLUMNS.ledger_rows), code: rowCodeOf(row.id as string) };
}

/** Runs carry `row_code` (from the work order's row) and `last_heartbeat_at` (from the lease). */
export function runRow(row: Row): Row {
  const { _ledger_row_id, ...rest } = row;
  return {
    ...parseJsonColumns(rest, JSON_COLUMNS.runs),
    row_code: rowCodeOf(_ledger_row_id as string | null),
    ...(rest.artifact_verified !== undefined ? { artifact_verified: rest.artifact_verified === 1 } : {}),
  };
}

/**
 * Evidence bundles: `body` parsed. The contract also names the parsed document `bundle`, so the
 * same object is offered under both names (`body` is the column, `bundle` the contract's alias).
 */
export function evidenceRow(row: Row): Row {
  const parsed = parseJsonColumns(row, JSON_COLUMNS.evidence_bundles);
  return { ...parsed, bundle: parsed.body, view: evidenceView(parsed.body) };
}

export function cardRow(row: Row): Row {
  const { _ledger_row_id, ...rest } = row;
  return {
    ...parseJsonColumns(rest, JSON_COLUMNS.decision_cards),
    row_code: rowCodeOf(_ledger_row_id as string | null),
  };
}

/**
 * SELECT list for runs with the derived columns. `sandbox_level` is not a runs column in Core: it
 * comes from a bundle's legacy `body.sandbox.level`, else the run.started payload (`sandbox_level`, which
 * `fw run start` writes; its contract-shaped bundle carries the level in automated_evidence), else null.
 */
export const RUN_SELECT = `
  SELECT r.*,
    w.ledger_row_id AS _ledger_row_id,
    COALESCE(
      (SELECT l.heartbeat_at FROM leases l WHERE l.id = r.lease_id),
      (SELECT l.heartbeat_at FROM leases l WHERE l.run_id = r.id ORDER BY l.acquired_at DESC LIMIT 1)
    ) AS last_heartbeat_at,
    COALESCE(
      (SELECT json_extract(e.body, '$.sandbox.level') FROM evidence_bundles e
        WHERE e.subject_ref = r.id ORDER BY e.created_at DESC LIMIT 1),
      (SELECT COALESCE(json_extract(ev.payload, '$.sandbox_level'), json_extract(ev.payload, '$.sandbox.level'))
         FROM events ev WHERE ev.run_id = r.id AND ev.type = 'run.started' ORDER BY ev.seq DESC LIMIT 1)
    ) AS sandbox_level,
    EXISTS (SELECT 1 FROM run_artifacts a WHERE a.run_id = r.id AND a.verified_by_kernel = 1) AS artifact_verified
  FROM runs r JOIN work_orders w ON w.id = r.work_order_id`;

export const CARD_SELECT = `
  SELECT c.*, json_extract(c.body, '$.source.ledger_row_id') AS _ledger_row_id,
    (SELECT p.name FROM projects p WHERE p.id = c.project_id) AS project_name
  FROM decision_cards c`;

/**
 * Per-project row counts for the web UI, and each project's brand and category (settings
 * 'project_labels', written by `fw project label`; null when unlabelled). "Open" is waiting to start (open, ready); "in progress" is
 * claimed through merging; "waiting on owner" is awaiting_approval or blocked.
 */
export const PROJECT_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM ledger_rows l WHERE l.project_id = p.id AND l.status IN ('open','ready')) AS rows_open,
    (SELECT COUNT(*) FROM ledger_rows l WHERE l.project_id = p.id
       AND l.status IN ('claimed','running','verifying','merging')) AS rows_in_progress,
    (SELECT COUNT(*) FROM ledger_rows l WHERE l.project_id = p.id
       AND l.status IN ('awaiting_approval','blocked')) AS rows_waiting_on_owner,
    json_extract((SELECT value FROM settings WHERE key = 'project_labels'), '$."' || p.id || '".brand') AS brand,
    json_extract((SELECT value FROM settings WHERE key = 'project_labels'), '$."' || p.id || '".category') AS category
  FROM projects p`;

export const URGENCY_ORDER = `CASE c.urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 WHEN 'this_week' THEN 2 ELSE 3 END`;
