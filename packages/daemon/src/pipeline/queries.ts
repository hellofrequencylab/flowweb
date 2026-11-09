// Read side of runs: `fw run list` and `fw run show`.
import type { Reader } from '@fw/eventlog';
import { codeFromRowId } from '@fw/ledger';

export interface RunSummary {
  id: string;
  row: string;
  status: string;
  failure_class: string | null;
  adapter: string;
  attempt: number;
  branch: string | null;
  queued_at: string;
  ended_at: string | null;
  /** Sum of the spend entries; null when none were recorded (cost unknown). */
  cost_usd: number | null;
}

export interface RunDetail extends RunSummary {
  work_order_id: string;
  agent_id: string;
  workspace_path: string | null;
  started_at: string | null;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  exit_code: number | null;
  cost: { usd: number | null; entries: number; known: boolean };
  artifacts: { kind: string; ref: string; sha: string | null; verified_by_kernel: boolean }[];
  evidence: {
    id: string;
    bundle_hash: string;
    subject_sha: string | null;
    scan_red: boolean;
    created_at: string;
  }[];
  steps: number;
  events: { seq: number; ts: string; type: string; payload: Record<string, unknown> }[];
}

const SELECT = `SELECT r.id, o.ledger_row_id AS row_id, r.status, r.failure_class, r.adapter_name AS adapter, r.attempt,
  r.branch, r.queued_at, r.ended_at,
  (SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(s.usd) END FROM spend_entries s WHERE s.run_id = r.id) AS cost_usd
  FROM runs r JOIN work_orders o ON o.id = r.work_order_id`;

type SummaryRow = Omit<RunSummary, 'row'> & { row_id: string };
const toSummary = ({ row_id, ...r }: SummaryRow): RunSummary => ({ ...r, row: codeFromRowId(row_id) });

export function listRuns(r: Reader, filter: { status?: string; limit?: number } = {}): RunSummary[] {
  const where = filter.status ? ' WHERE r.status = ?' : '';
  const rows = r.all<SummaryRow>(`${SELECT}${where} ORDER BY r.queued_at DESC, r.id DESC LIMIT ?`, [
    ...(filter.status ? [filter.status] : []),
    filter.limit ?? 50,
  ]);
  return rows.map(toSummary);
}

export class RunNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
}

export function showRun(r: Reader, runId: string): RunDetail {
  const s = r.get<SummaryRow>(`${SELECT} WHERE r.id = ?`, [runId]);
  if (!s) throw new RunNotFoundError(`run ${runId} not found`);
  const x = r.get<{
    work_order_id: string;
    agent_id: string;
    workspace_path: string | null;
    started_at: string | null;
    turns: number;
    tokens_in: number;
    tokens_out: number;
    exit_code: number | null;
  }>(
    'SELECT work_order_id, agent_id, workspace_path, started_at, turns, tokens_in, tokens_out, exit_code FROM runs WHERE id = ?',
    [runId],
  )!;
  const entries =
    r.get<{ n: number }>('SELECT COUNT(*) AS n FROM spend_entries WHERE run_id = ?', [runId])?.n ?? 0;
  const artifacts = r
    .all<{ kind: string; ref: string; sha: string | null; v: number }>(
      'SELECT kind, ref, sha, verified_by_kernel AS v FROM run_artifacts WHERE run_id = ? ORDER BY id',
      [runId],
    )
    .map((a) => ({ kind: a.kind, ref: a.ref, sha: a.sha, verified_by_kernel: a.v === 1 }));
  const evidence = r
    .all<{
      id: string;
      bundle_hash: string;
      subject_sha: string | null;
      scan_red: number;
      created_at: string;
    }>(
      'SELECT id, bundle_hash, subject_sha, scan_red, created_at FROM evidence_bundles WHERE subject_ref = ? ORDER BY created_at',
      [runId],
    )
    .map((e) => ({ ...e, scan_red: e.scan_red === 1 }));
  const steps = r.get<{ n: number }>('SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?', [runId])?.n ?? 0;
  const events = r
    .all<{ seq: number; ts: string; type: string; payload: string }>(
      'SELECT seq, ts, type, payload FROM events WHERE run_id = ? ORDER BY seq',
      [runId],
    )
    .map((e) => ({
      seq: e.seq,
      ts: e.ts,
      type: e.type,
      payload: JSON.parse(e.payload) as Record<string, unknown>,
    }));
  const summary = toSummary(s);
  return {
    ...summary,
    ...x,
    cost: { usd: summary.cost_usd, entries, known: entries > 0 },
    artifacts,
    evidence,
    steps,
    events,
  };
}
