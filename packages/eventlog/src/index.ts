export const PACKAGE = '@fw/eventlog';

export {
  checkRow,
  EVENT_COLUMNS,
  type EventRow,
  envelopeHash,
  envelopeOf,
  GENESIS_HASH,
  payloadHash,
} from './envelope.ts';
export {
  EventLogError,
  ForbiddenStatementError,
  SchemaMismatchError,
  SecretShapeError,
  StoreClosedError,
  WriterLockError,
} from './errors.ts';
export { hasSecretShape, REDACTED, REDACTION_KEY, type RedactionResult, redactSecrets } from './redact.ts';
export { DEFAULT_SCHEMA_PATH, MIGRATION_0001_KEY, openStore } from './store.ts';
export type * from './types.ts';
export { canonicalJson, newId, nowIso, sha256Hex } from './util.ts';
