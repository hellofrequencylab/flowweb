// Ledger row state machine (WS-P0-016). The transition table mirrors legal_transitions
// (machine = 'ledger_row') in schema.core.sql; a test keeps the two equal. The SQL triggers stay the
// authority: this layer refuses an illegal move early with the same wording, then runs the UPDATE and
// its ledger.row_status_changed event in one transaction, and surfaces any trigger refusal verbatim.
import type { Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from './bootstrap.ts';
import { LedgerError, surfaceDbRefusal } from './errors.ts';
import { codeFromRowId } from './ids.ts';
import { getDbRow, type RowStatus } from './rows.ts';

export const ROW_STATUSES: readonly RowStatus[] = [
  'open',
  'ready',
  'claimed',
  'running',
  'verifying',
  'awaiting_approval',
  'merging',
  'watching',
  'done',
  'blocked',
  'parked',
  'regressed',
];

/** [from, to] pairs, in the order of the legal_transitions seed. */
export const LEDGER_TRANSITIONS: ReadonlyArray<readonly [RowStatus, RowStatus]> = [
  ['open', 'ready'],
  ['open', 'parked'],
  ['open', 'blocked'],
  ['ready', 'claimed'],
  ['ready', 'parked'],
  ['ready', 'blocked'],
  ['ready', 'open'],
  ['claimed', 'running'],
  ['claimed', 'ready'],
  ['claimed', 'blocked'],
  ['running', 'verifying'],
  ['running', 'ready'],
  ['running', 'blocked'],
  ['running', 'parked'],
  ['verifying', 'awaiting_approval'],
  ['verifying', 'merging'],
  ['verifying', 'running'],
  ['verifying', 'blocked'],
  ['verifying', 'done'],
  ['awaiting_approval', 'merging'],
  ['awaiting_approval', 'running'],
  ['awaiting_approval', 'ready'],
  ['awaiting_approval', 'parked'],
  ['merging', 'watching'],
  ['merging', 'running'],
  ['merging', 'blocked'],
  ['watching', 'done'],
  ['watching', 'regressed'],
  ['done', 'regressed'],
  ['regressed', 'ready'],
  ['regressed', 'open'],
  ['regressed', 'parked'],
  ['blocked', 'ready'],
  ['blocked', 'open'],
  ['blocked', 'parked'],
  ['parked', 'open'],
  ['parked', 'ready'],
  // 1.2.0-core: a row built outside fwd closes on a passing probe (trg_ledger_done_requires_proof).
  ['open', 'done'],
  ['parked', 'done'],
];

const LEGAL = new Set(LEDGER_TRANSITIONS.map(([f, t]) => `${f}>${t}`));

/** Pure check against the transition table. A no-op (from === to) is not a transition. */
export function isLegalTransition(from: RowStatus, to: RowStatus): boolean {
  return LEGAL.has(`${from}>${to}`);
}

/** Columns a transition may set together with status (each guarded by the triggers where it matters). */
const SETTABLE = new Set([
  'merged_sha',
  'evidence_bundle_id',
  'closed_at',
  'premise_valid',
  'premise_retested_at',
  'watch_until',
]);

export interface TransitionOptions {
  actor?: Actor;
  /** Why the guard holds (result ids, reasons); stored in the event payload. */
  guard_evidence?: Record<string, unknown>;
  /** Other columns written in the same UPDATE as the status. */
  set?: Record<string, string | number | null>;
}

export interface TransitionResult {
  code: string;
  id: string;
  from: RowStatus;
  to: RowStatus;
  event_id: string;
  event_seq: number;
}

/**
 * Moves a row to `to` in one transaction with its ledger.row_status_changed event. Throws
 * ILLEGAL_TRANSITION for a move the table does not allow, REFUSED_BY_DATABASE (trigger message)
 * when a guard trigger refuses; either way nothing is written.
 */
export function transitionRow(
  w: Writer,
  codeOrId: string,
  to: RowStatus,
  opts: TransitionOptions = {},
): TransitionResult {
  return w.transaction((tx) => {
    const row = getDbRow(tx, codeOrId);
    const code = codeFromRowId(row.id);
    if (!isLegalTransition(row.status, to))
      throw new LedgerError(
        'ILLEGAL_TRANSITION',
        `illegal ledger_row transition: ${code} ${row.status} -> ${to}`,
        { code, from: row.status, to },
      );
    const set = opts.set ?? {};
    for (const k of Object.keys(set))
      if (!SETTABLE.has(k)) throw new LedgerError('BAD_ARGUMENT', `a transition cannot set ${k}`);
    const cols = ['status = ?', ...Object.keys(set).map((k) => `${k} = ?`)];
    surfaceDbRefusal(
      () =>
        tx.run(`UPDATE ledger_rows SET ${cols.join(', ')} WHERE id = ?`, [to, ...Object.values(set), row.id]),
      { code, from: row.status, to },
    );
    const actor = opts.actor ?? ownerActor(tx);
    const prior = tx.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'ledger.row_status_changed' AND json_extract(payload, '$.ledger_row_id') = ?",
      [row.id],
    );
    const ev = tx.appendEvent({
      type: 'ledger.row_status_changed',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: row.project_id,
      stream_id: row.stream_id,
      idempotency_key: `${row.id}+${to}+${(prior?.n ?? 0) + 1}`,
      payload: {
        ledger_row_id: row.id,
        code,
        from: row.status,
        to,
        guard_evidence: opts.guard_evidence ?? {},
        actor: { kind: actor.kind, id: actor.id },
      },
    });
    return { code, id: row.id, from: row.status, to, event_id: ev.id, event_seq: ev.seq };
  });
}
