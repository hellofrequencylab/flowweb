// Store port of @fw/eventlog. This is the ONLY way any package touches the database.
// The daemon holds the single Writer; everything else gets a Reader (read-only connection).
// Implemented by FW-C-003 / FW-C-004. Other packages (ledger, policy, daemon) code against these types.

export type ActorKind = 'owner' | 'agent' | 'system' | 'adapter';

/** What a caller supplies. The store fills seq, id, ts, payload_hash, prev_hash and hash. */
export interface EventInput {
  type: string; // must exist in event_types (closed union, enforced by the schema)
  actor_kind: ActorKind;
  actor_id: string;
  project_id?: string | null;
  stream_id?: string | null;
  work_order_id?: string | null;
  run_id?: string | null;
  correlation_id?: string; // defaults to a new id
  causation_id?: string | null;
  idempotency_key?: string; // defaults to the new event id; (type, idempotency_key) is unique
  version?: number;
  payload: Record<string, unknown>;
}

export interface StoredEvent extends Required<Omit<EventInput, 'payload'>> {
  seq: number;
  id: string;
  ts: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  prev_hash: string;
  hash: string;
}

export type SqlParams = Record<string, unknown> | unknown[];

export interface Reader {
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
}

export interface Writer extends Reader {
  /** Redacts, then appends one hash-chained event inside the current (or a new) transaction. */
  appendEvent(input: EventInput): StoredEvent;
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint };
  /** Runs fn in one IMMEDIATE transaction; nested calls join the outer transaction. */
  transaction<T>(fn: (w: Writer) => T): T;
}

export type VerifyResult =
  | { ok: true; count: number; head: string }
  | { ok: false; seq: number; reason: string; count: number };

export interface Store {
  readonly path: string;
  /** Throws WriterLockError when another process holds the writer lock. Undefined on a read-only store. */
  readonly writer: Writer | undefined;
  reader(): Reader;
  verifyChain(): VerifyResult;
  close(): void;
}

export interface OpenStoreOptions {
  /** Path to fw.sqlite. ':memory:' allowed for tests. */
  path: string;
  /** Open read-only (no writer lock, no migration). Default false. */
  readonly?: boolean;
  /** Clock override for tests. */
  now?: () => Date;
  /** Migration 0001 file. Default: schema.core.sql at the repo root (../../schema.core.sql from this package). */
  schemaPath?: string;
  /** Writer lock file. Default: `${path}.lock` next to the database. */
  lockPath?: string;
}
