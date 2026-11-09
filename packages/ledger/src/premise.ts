// Premise re-test (WS-P0-020). Before a row becomes workable its probe runs against the current
// checkout. A failing probe proves the premise ("the problem still exists"): the row moves to
// ready (the trigger requires premise_valid=1 and last_probe_status=fail). A passing probe means the
// work is already done: per the Core adaptation the row is parked as already_satisfied and is not
// claimable. A probe that could not run, or timed out, proves nothing: the row stays where it is.
import { nowIso, type Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from './bootstrap.ts';
import { LedgerError } from './errors.ts';
import { isLegalTransition, transitionRow } from './fsm.ts';
import { gitHead } from './git.ts';
import { codeFromRowId } from './ids.ts';
import { executeCommandProbe, type ProbeRunResult, recordProbeResult, runnableProbe } from './probe.ts';
import { getDbRow, type RowStatus } from './rows.ts';

export type PremiseOutcome = 'ready' | 'parked' | 'unchanged';

export interface PremiseReport {
  code: string;
  outcome: PremiseOutcome;
  /** True: the probe failed, so the premise holds. False: already satisfied. Null: inconclusive. */
  still_valid: boolean | null;
  from: RowStatus;
  to: RowStatus;
  result_id: string;
  base_sha: string | null;
  probe: ProbeRunResult;
}

export interface PremiseOptions {
  repoDir: string;
  actor?: Actor;
  now?: () => Date;
  timeoutMs?: number;
}

export async function retestPremise(w: Writer, code: string, opts: PremiseOptions): Promise<PremiseReport> {
  const now = opts.now ?? (() => new Date());
  const row = getDbRow(w, code);
  const rowCode = codeFromRowId(row.id);
  if (!isLegalTransition(row.status, 'ready'))
    throw new LedgerError(
      'PREMISE_STATE',
      `${rowCode} is ${row.status}; a premise re-test applies only to a row that may become ready`,
      { code: rowCode, status: row.status },
    );
  const actor = opts.actor ?? ownerActor(w);
  const probe = runnableProbe(w, row, opts.repoDir, actor);
  const baseSha = gitHead(opts.repoDir) ?? null;
  const result = await executeCommandProbe(probe, {
    cwd: opts.repoDir,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const conclusive = result.status !== 'error' && !result.timed_out;
  const stillValid = conclusive ? result.status === 'fail' : null;

  return w.transaction((tx) => {
    const fresh = getDbRow(tx, row.id);
    if (fresh.status !== row.status || fresh.probe_hash !== row.probe_hash)
      throw new LedgerError('PREMISE_STATE', `${rowCode} changed while its probe ran; re-test again`);
    const rec = recordProbeResult(tx, fresh, result, { kind: 'branch', sha: baseSha }, actor, now);
    const at = nowIso(now());
    tx.appendEvent({
      type: 'ledger.row_premise_retested',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: row.project_id,
      stream_id: row.stream_id,
      idempotency_key: `${row.id}+${rec.result_id}`,
      payload: {
        ledger_row_id: row.id,
        code: rowCode,
        still_valid: stillValid,
        result: stillValid === null ? 'inconclusive' : stillValid ? 'probe_fails' : 'already_satisfied',
        method: `ran the row probe against ${baseSha ?? 'the working tree'}`,
        evidence_ref: `result:${rec.result_id}`,
        retest_nonce: rec.result_id,
      },
    });
    let to: RowStatus = row.status;
    let outcome: PremiseOutcome = 'unchanged';
    if (stillValid === true) {
      transitionRow(tx, row.id, 'ready', {
        actor,
        guard_evidence: { premise: 'probe_fails', result_id: rec.result_id, base_sha: baseSha },
        set: { premise_valid: 1, premise_retested_at: at },
      });
      to = 'ready';
      outcome = 'ready';
    } else if (stillValid === false) {
      if (isLegalTransition(row.status, 'parked')) {
        transitionRow(tx, row.id, 'parked', {
          actor,
          guard_evidence: { reason: 'already_satisfied', result_id: rec.result_id, base_sha: baseSha },
          set: { premise_valid: 0, premise_retested_at: at },
        });
        to = 'parked';
        outcome = 'parked';
      } else {
        tx.run('UPDATE ledger_rows SET premise_valid = 0, premise_retested_at = ? WHERE id = ?', [
          at,
          row.id,
        ]);
      }
    }
    return {
      code: rowCode,
      outcome,
      still_valid: stillValid,
      from: row.status,
      to,
      result_id: rec.result_id,
      base_sha: baseSha,
      probe: result,
    };
  });
}
