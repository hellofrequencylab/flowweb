// Typed errors of @fw/eventlog. Callers branch on `instanceof` or on `code`, never on message text.

export class EventLogError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Another process (or another Store in this process) holds the single writer lock. */
export class WriterLockError extends EventLogError {
  readonly lockPath: string;
  readonly holderPid: number | undefined;
  constructor(lockPath: string, holderPid: number | undefined) {
    super(
      'LOCKED',
      `event log writer lock is held${holderPid === undefined ? '' : ` by pid ${holderPid}`}: ${lockPath}`,
    );
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

/** The database was migrated from a schema file whose sha256 differs from the one on disk now. */
export class SchemaMismatchError extends EventLogError {
  readonly recorded: string | undefined;
  readonly current: string;
  constructor(recorded: string | undefined, current: string, schemaPath: string) {
    super(
      'SCHEMA_MISMATCH',
      recorded === undefined
        ? `database has no recorded migration 0001 hash; refusing to start (schema file ${schemaPath})`
        : `migration 0001 hash mismatch: database recorded ${recorded}, ${schemaPath} is ${current}; refusing to start`,
    );
    this.recorded = recorded;
    this.current = current;
  }
}

/** A statement the Store port does not hand out (it would weaken a guarantee such as foreign keys). */
export class ForbiddenStatementError extends EventLogError {
  constructor(reason: string) {
    super('FORBIDDEN_STATEMENT', reason);
  }
}

/** The store was closed, or the operation needs a writer on a read-only store. */
export class StoreClosedError extends EventLogError {
  constructor(message = 'store is closed') {
    super('CLOSED', message);
  }
}

/** A payload still looks like it carries a secret after redaction; nothing was written. */
export class SecretShapeError extends EventLogError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SECRET_SHAPE', message, options);
  }
}
