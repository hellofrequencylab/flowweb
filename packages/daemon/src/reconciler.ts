// Startup reconciler. fwd is the only process that runs work, so when it starts nothing can be
// legitimately in flight: a run left in starting, running or validating is an orphan of a crash.
// Each orphan is failed (failure_class 'killed'), its lease released, and the expired leases of
// everyone else are marked expired. Every change emits an event in the same transaction, and only
// legal_transitions are used (starting/running/validating -> failed are all legal for 'run').
// Paused runs are left alone: they wait on a person, not on a process.
// A crashed `fw run start` can leave its vendor process group behind: the reconciler kills it (the
// group id is on run.started; on Linux the leader's cwd must be inside the run's workspace, so a
// reused id is never signalled) and settles the work order and row the way a failed run would.
import { readlinkSync } from 'node:fs';
import { groupAlive } from '@fw/adapters';
import type { Writer } from '@fw/eventlog';
import { settleRowAfterFailure } from './pipeline/records.ts';
import { isInside } from './runtime/paths.ts';

export const ORPHAN_STATES = ['starting', 'running', 'validating'] as const;
const ACTOR = { actor_kind: 'system', actor_id: 'fwd.reconciler' } as const;

export interface ReconcileReport {
  runs_failed: string[];
  leases_released: string[];
  leases_expired: string[];
  /** Vendor process groups of orphaned runs that were still alive and were killed. */
  groups_killed: number[];
  duration_ms: number;
}

export type GroupOutcome = 'none' | 'gone' | 'killed' | 'unverified';

/** Kills a crashed run's vendor process group, only when it provably belongs to that run. */
export function killOrphanGroup(pgid: number | null, workspace: string | null): GroupOutcome {
  if (pgid === null || !Number.isInteger(pgid) || pgid <= 1) return 'none';
  if (!groupAlive(pgid)) return 'gone';
  if (process.platform === 'linux') {
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pgid}/cwd`);
    } catch {
      return 'unverified';
    }
    if (!workspace || !isInside(workspace, cwd)) return 'unverified';
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    return groupAlive(pgid) ? 'unverified' : 'gone';
  }
  return 'killed';
}

function vendorPgid(w: Writer, runId: string): number | null {
  const ev = w.get<{ payload: string }>(
    "SELECT payload FROM events WHERE run_id = ? AND type = 'run.started' ORDER BY seq DESC LIMIT 1",
    [runId],
  );
  if (!ev) return null;
  const v = (JSON.parse(ev.payload) as { vendor_pgid?: unknown }).vendor_pgid;
  return typeof v === 'number' ? v : null;
}

interface OrphanRun {
  id: string;
  status: string;
  project_id: string;
  stream_id: string;
  work_order_id: string;
  lease_id: string | null;
  workspace_path: string | null;
}

interface LeaseRow {
  id: string;
  heartbeat_at: string;
  run_id: string | null;
}

export function reconcileOnStart(w: Writer, opts: { now?: () => Date; bootId: string }): ReconcileReport {
  const t0 = Date.now();
  const now = () => (opts.now ?? (() => new Date()))().toISOString();
  return w.transaction((tx) => {
    const report: ReconcileReport = {
      runs_failed: [],
      leases_released: [],
      leases_expired: [],
      groups_killed: [],
      duration_ms: 0,
    };
    const orphans = tx.all<OrphanRun>(
      `SELECT id, status, project_id, stream_id, work_order_id, lease_id, workspace_path FROM runs
        WHERE status IN (${ORPHAN_STATES.map(() => '?').join(',')}) ORDER BY id`,
      [...ORPHAN_STATES],
    );
    for (const run of orphans) {
      const pgid = vendorPgid(tx, run.id);
      const group = killOrphanGroup(pgid, run.workspace_path);
      if (group === 'killed' && pgid !== null) report.groups_killed.push(pgid);
      const at = now();
      const r = tx.run(
        `UPDATE runs SET status = 'failed', failure_class = 'killed', ended_at = ?
          WHERE id = ? AND status = ?`,
        [at, run.id, run.status],
      );
      if (r.changes !== 1) continue;
      report.runs_failed.push(run.id);
      tx.appendEvent({
        ...ACTOR,
        type: 'run.failed',
        project_id: run.project_id,
        stream_id: run.stream_id,
        work_order_id: run.work_order_id,
        run_id: run.id,
        idempotency_key: `${run.id}:failed`,
        payload: {
          run_id: run.id,
          failure_class: 'killed',
          detail: `orphaned: fwd stopped while the run was ${run.status}; failed on restart, not retried`,
          previous_status: run.status,
          vendor_group: { pgid, outcome: group },
        },
      });
      const leases = tx.all<LeaseRow>(
        `SELECT id, heartbeat_at, run_id FROM leases
          WHERE status = 'active' AND (id = ? OR run_id = ?) ORDER BY id`,
        [run.lease_id, run.id],
      );
      for (const lease of leases) {
        tx.run(`UPDATE leases SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'`, [
          at,
          lease.id,
        ]);
        report.leases_released.push(lease.id);
        tx.appendEvent({
          ...ACTOR,
          type: 'lease.released',
          run_id: run.id,
          idempotency_key: `${lease.id}:released`,
          payload: { lease_id: lease.id, reason: 'run_orphaned', run_id: run.id },
        });
      }
      // The work order goes back to issued and the row to ready or blocked, unless another run is live.
      try {
        settleRowAfterFailure(tx, run, 'failed: killed (orphaned)');
      } catch {
        // A row the reconciler cannot move stays where it is; the run itself is settled above.
      }
    }
    const at = now();
    const expired = tx.all<LeaseRow>(
      `SELECT id, heartbeat_at, run_id FROM leases WHERE status = 'active' AND expires_at <= ? ORDER BY id`,
      [at],
    );
    for (const lease of expired) {
      tx.run(`UPDATE leases SET status = 'expired', released_at = ? WHERE id = ? AND status = 'active'`, [
        at,
        lease.id,
      ]);
      report.leases_expired.push(lease.id);
      tx.appendEvent({
        ...ACTOR,
        type: 'lease.expired',
        run_id: lease.run_id,
        idempotency_key: `${lease.id}:expired`,
        payload: { lease_id: lease.id, last_heartbeat_at: lease.heartbeat_at },
      });
    }
    report.duration_ms = Date.now() - t0;
    const drift = report.runs_failed.length + report.leases_released.length + report.leases_expired.length;
    tx.appendEvent({
      ...ACTOR,
      type: 'reconciler.completed',
      idempotency_key: `startup:${opts.bootId}`,
      payload: {
        scope: 'startup',
        items_checked: orphans.length + expired.length,
        drift_count: drift,
        duration_ms: report.duration_ms,
        runs_failed: report.runs_failed,
        leases_released: report.leases_released,
        leases_expired: report.leases_expired,
        groups_killed: report.groups_killed,
      },
    });
    return report;
  });
}
