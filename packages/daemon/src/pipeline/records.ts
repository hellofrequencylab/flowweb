// Database side of a run: the writes the pipeline and the reconciler share. Every status change
// goes through a legal transition and emits its event in the same transaction. The SQL triggers
// stay the authority; these helpers only pick the legal next state.
import { type ActorKind, nowIso, type Reader, type Writer } from '@fw/eventlog';
import { type RowStatus, transitionRow } from '@fw/ledger';

export const SUPERVISOR = { actor_kind: 'system' as ActorKind, actor_id: 'fwd.supervisor' };
export const ACTIVE_RUN_STATES = ['queued', 'starting', 'running', 'paused', 'validating'] as const;

export type FailureClass =
  | 'adapter'
  | 'schema'
  | 'no_artifact'
  | 'claim_mismatch'
  | 'nonzero_exit'
  | 'timeout'
  | 'budget'
  | 'killed'
  | 'cancelled';

export type EndState = 'failed' | 'timed_out' | 'killed' | 'cancelled';

export interface RunRow {
  id: string;
  work_order_id: string;
  project_id: string;
  stream_id: string;
  agent_id: string;
  status: string;
  lease_id: string | null;
  failure_class: string | null;
  workspace_path: string | null;
  branch: string | null;
}

export function getRun(r: Reader, runId: string): RunRow {
  const run = r.get<RunRow>(
    'SELECT id, work_order_id, project_id, stream_id, agent_id, status, lease_id, failure_class, workspace_path, branch FROM runs WHERE id = ?',
    [runId],
  );
  if (!run) throw new Error(`run ${runId} not found`);
  return run;
}

function base(run: Pick<RunRow, 'id' | 'project_id' | 'stream_id' | 'work_order_id'>) {
  return {
    ...SUPERVISOR,
    project_id: run.project_id,
    stream_id: run.stream_id,
    work_order_id: run.work_order_id,
    run_id: run.id,
  };
}

/** Releases every active lease of a run, one lease.released event each. */
export function releaseLeases(w: Writer, run: RunRow, reason: string, now: () => Date): string[] {
  const leases = w.all<{ id: string }>(
    "SELECT id FROM leases WHERE status = 'active' AND (id = ? OR run_id = ?) ORDER BY id",
    [run.lease_id, run.id],
  );
  for (const l of leases) {
    w.run("UPDATE leases SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'", [
      nowIso(now()),
      l.id,
    ]);
    w.appendEvent({
      ...base(run),
      type: 'lease.released',
      idempotency_key: `${l.id}:released`,
      payload: { lease_id: l.id, reason, run_id: run.id },
    });
  }
  return leases.map((l) => l.id);
}

export interface SettleReport {
  run_status: string;
  work_order_status: string | null;
  row_status: RowStatus | null;
  leases_released: string[];
}

/**
 * After a run ends without success: the work order goes back to issued (a retry is allowed) when no
 * other run of it is live, and the row goes back to ready when the premise still holds (the ready
 * trigger checks that), else to blocked. Nothing moves when another run of the order is still live.
 */
export function settleRowAfterFailure(
  w: Writer,
  run: Pick<RunRow, 'id' | 'work_order_id'>,
  reason: string,
): { work_order_status: string | null; row_status: RowStatus | null } {
  const wo = w.get<{ status: string; ledger_row_id: string }>(
    'SELECT status, ledger_row_id FROM work_orders WHERE id = ?',
    [run.work_order_id],
  );
  if (!wo) return { work_order_status: null, row_status: null };
  const others = w.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM runs WHERE work_order_id = ? AND id <> ? AND status IN (${ACTIVE_RUN_STATES.map(() => '?').join(',')})`,
    [run.work_order_id, run.id, ...ACTIVE_RUN_STATES],
  );
  if ((others?.n ?? 0) > 0) return { work_order_status: wo.status, row_status: null };
  let woStatus = wo.status;
  if (wo.status === 'running') {
    w.run("UPDATE work_orders SET status = 'issued' WHERE id = ? AND status = 'running'", [
      run.work_order_id,
    ]);
    woStatus = 'issued';
  }
  const row = w.get<{ status: RowStatus; premise_valid: number | null; last_probe_status: string }>(
    'SELECT status, premise_valid, last_probe_status FROM ledger_rows WHERE id = ?',
    [wo.ledger_row_id],
  );
  if (!row || (row.status !== 'running' && row.status !== 'claimed'))
    return { work_order_status: woStatus, row_status: row?.status ?? null };
  const canBeReady = row.premise_valid === 1 && row.last_probe_status === 'fail';
  const to: RowStatus = canBeReady ? 'ready' : 'blocked';
  transitionRow(w, wo.ledger_row_id, to, {
    actor: { kind: 'system', id: SUPERVISOR.actor_id },
    guard_evidence: {
      run_id: run.id,
      reason,
      ...(canBeReady
        ? {}
        : { blocked_because: `the premise no longer holds (last probe ${row.last_probe_status})` }),
    },
  });
  return { work_order_status: woStatus, row_status: to };
}

export interface EndRunInput {
  run: RunRow;
  to: EndState;
  failure_class: FailureClass;
  detail: string;
  /** Extra payload for the end event (never secrets). */
  extra?: Record<string, unknown>;
  /** Columns written with the status (result, cost, turns...). */
  set?: Record<string, string | number | null>;
  now?: () => Date;
}

const END_EVENT: Record<EndState, string> = {
  failed: 'run.failed',
  timed_out: 'run.timed_out',
  killed: 'run.killed',
  cancelled: 'run.cancelled',
};

/** Ends a run that did not succeed, in one transaction: status, event, leases, order and row. */
export function endRun(w: Writer, input: EndRunInput): SettleReport {
  const now = input.now ?? (() => new Date());
  return w.transaction((tx) => {
    const run = getRun(tx, input.run.id);
    const set = { ...(input.set ?? {}) };
    const cols = Object.keys(set);
    // The spend trigger may already have killed the run: keep its status and failure class.
    const status = run.status === 'killed' ? 'killed' : input.to;
    const failure =
      run.status === 'killed' ? (run.failure_class ?? input.failure_class) : input.failure_class;
    tx.run(
      `UPDATE runs SET status = ?, failure_class = ?, ended_at = COALESCE(ended_at, ?)${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`,
      [status, failure, nowIso(now()), ...Object.values(set), run.id],
    );
    const type = END_EVENT[status as EndState];
    tx.appendEvent({
      ...base(run),
      type,
      idempotency_key: `${run.id}+${status}`,
      payload: {
        run_id: run.id,
        failure_class: failure,
        detail: input.detail,
        previous_status: run.status,
        ...(status === 'cancelled' ? { by: SUPERVISOR.actor_id, reason: input.detail } : {}),
        ...input.extra,
      },
    });
    const leases = releaseLeases(tx, run, `run_${status}`, now);
    const settled = settleRowAfterFailure(tx, run, `${status}: ${failure}`);
    return { run_status: status, ...settled, leases_released: leases };
  });
}
