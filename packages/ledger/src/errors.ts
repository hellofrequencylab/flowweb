// Typed errors of @fw/ledger. Callers branch on `code`, never on message text.
// A refusal by a database trigger keeps the trigger's own message, so the reason a person sees is
// the rule that fired, word for word.

export type LedgerErrorCode =
  | 'BAD_ARGUMENT'
  | 'NOT_FOUND'
  | 'NO_DATABASE'
  | 'INVALID_DEFINITION'
  | 'ILLEGAL_TRANSITION'
  | 'REFUSED_BY_DATABASE'
  | 'PROBE_TAMPERED'
  | 'PROBE_CHANGED'
  | 'PROBE_UNSUPPORTED'
  | 'PREMISE_STATE'
  | 'NOT_A_GIT_REPO'
  | 'MERGED_SHA_MISMATCH'
  | 'DIRTY_WORKTREE'
  | 'ROW_NOT_READY'
  | 'SIZE_NOT_DISPATCHABLE'
  | 'SELF_VERIFY'
  | 'AGENT_INVALID'
  | 'ALREADY_ISSUED'
  | 'WORK_ORDER_INVALID'
  | 'POLICY_MISSING';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly details: Record<string, unknown>;
  constructor(
    code: LedgerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}

/** True for a better-sqlite3 error raised by a constraint or by RAISE(ABORT) in a trigger. */
function isConstraintError(e: unknown): e is Error & { code: string } {
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Runs fn; a database refusal (trigger or CHECK) becomes REFUSED_BY_DATABASE carrying its own message. */
export function surfaceDbRefusal<T>(fn: () => T, details: Record<string, unknown> = {}): T {
  try {
    return fn();
  } catch (e) {
    if (isConstraintError(e)) {
      throw new LedgerError(
        'REFUSED_BY_DATABASE',
        e.message,
        { ...details, sqlite_code: e.code },
        { cause: e },
      );
    }
    throw e;
  }
}
