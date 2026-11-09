// SQLite implementation of the Store port (types.ts) on better-sqlite3.
// - WAL mode; PRAGMA foreign_keys=ON on every connection, checked, never handed out off.
// - schema.core.sql is migration 0001; its sha256 is recorded in schema_meta and checked on every open.
// - One writer, guarded by a process-level lock file; readers use separate read-only connections.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  checkRow,
  EVENT_COLUMNS,
  type EventRow,
  envelopeHash,
  envelopeOf,
  GENESIS_HASH,
} from './envelope.ts';
import {
  ForbiddenStatementError,
  SchemaMismatchError,
  SecretShapeError,
  StoreClosedError,
} from './errors.ts';
import { acquireWriterLock, type WriterLock } from './lock.ts';
import { hasSecretShape, REDACTION_KEY, redactSecrets } from './redact.ts';
import type {
  EventInput,
  OpenStoreOptions,
  Reader,
  SqlParams,
  Store,
  StoredEvent,
  VerifyResult,
  Writer,
} from './types.ts';
import { canonicalJson, newId, nowIso, sha256Hex } from './util.ts';

type DB = Database.Database;

export const DEFAULT_SCHEMA_PATH = resolve(import.meta.dirname, '../../../schema.core.sql');
export const MIGRATION_0001_KEY = 'migration_0001_sha256';
const BUSY_TIMEOUT_MS = 5000;

// Statements the port refuses to run: they would switch off a guarantee the schema relies on,
// or write the event log around appendEvent (and so around redaction and hashing).
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [
    /\bpragma\s+(\w+\.)?foreign_keys\s*[=(]/i,
    'foreign_keys is always ON and cannot be changed through the store',
  ],
  [
    /\bpragma\s+(\w+\.)?(writable_schema|ignore_check_constraints|defer_foreign_keys)\s*[=(]/i,
    'pragma refused',
  ],
  [/\bdrop\s+trigger\b/i, 'triggers are part of the schema and cannot be dropped through the store'],
  [
    /\b(insert|replace)\s+(or\s+\w+\s+)?into\s+(main\.)?["`[]?events\b/i,
    'events are written only by appendEvent',
  ],
  [/^\s*attach\b/i, 'attaching databases is refused'],
];

function checkStatement(sql: string): void {
  for (const [re, reason] of FORBIDDEN) if (re.test(sql)) throw new ForbiddenStatementError(reason);
}

function bind(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

function configure(db: DB, writable: boolean): void {
  if (writable) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('foreign_keys = ON');
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    db.close();
    throw new Error('could not enable foreign_keys on a new connection');
  }
}

function hasSchemaMeta(db: DB): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_meta'").get() !== undefined
  );
}

function checkSchemaHash(db: DB, current: string, schemaPath: string): void {
  const row = hasSchemaMeta(db)
    ? (db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(MIGRATION_0001_KEY) as
        | { value: string }
        | undefined)
    : undefined;
  if (row?.value !== current) throw new SchemaMismatchError(row?.value, current, schemaPath);
}

const PRAGMA_LINE = /^[ \t]*PRAGMA[ \t]+[^;\n]+;[ \t]*$/gim;

function migrate(db: DB, schemaText: string, schemaSha: string, now: () => Date): void {
  // Standalone PRAGMA lines (journal_mode, synchronous, foreign_keys) cannot run inside a
  // transaction, so they run first; the rest of the file is applied atomically. The recorded
  // hash is always of the unmodified file.
  for (const m of schemaText.match(PRAGMA_LINE) ?? []) db.exec(m);
  const body = schemaText.replace(PRAGMA_LINE, '');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(body);
    db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?), (?, ?)').run(
      MIGRATION_0001_KEY,
      schemaSha,
      'migration_0001_applied_at',
      nowIso(now()),
    );
    db.exec('COMMIT');
  } catch (e) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw e;
  }
  // The schema file sets foreign_keys at its top, where (inside a transaction) it is a no-op.
  configure(db, true);
}

function makeReader(db: DB, readOnly: boolean, isOpen: () => boolean): Reader {
  const prep = (sql: string) => {
    if (!isOpen()) throw new StoreClosedError();
    checkStatement(sql);
    const stmt = db.prepare(sql);
    // SQLite does not count a pragma query as read-only; a bare `PRAGMA name` only reads.
    const pragmaRead = /^\s*pragma\s+[\w.]+\s*;?\s*$/i.test(sql);
    if (readOnly && !stmt.readonly && !pragmaRead) {
      throw new ForbiddenStatementError('a reader cannot write');
    }
    return stmt;
  };
  return {
    get<T>(sql: string, params?: SqlParams) {
      return prep(sql).get(...bind(params)) as T | undefined;
    },
    all<T>(sql: string, params?: SqlParams) {
      return prep(sql).all(...bind(params)) as T[];
    },
  };
}

function toStored(row: EventRow): StoredEvent {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

function makeWriter(db: DB, now: () => Date, isOpen: () => boolean): Writer {
  const reader = makeReader(db, false, isOpen);
  const insert = db.prepare(
    `INSERT INTO events(${EVENT_COLUMNS}) VALUES (${EVENT_COLUMNS.split(',')
      .map((c) => `@${c}`)
      .join(',')})`,
  );
  const byKey = db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE type = ? AND idempotency_key = ?`);
  const head = db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1');

  const writer: Writer = {
    get: reader.get,
    all: reader.all,
    run(sql, params) {
      if (!isOpen()) throw new StoreClosedError();
      checkStatement(sql);
      const r = db.prepare(sql).run(...bind(params));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    transaction<T>(fn: (w: Writer) => T): T {
      if (!isOpen()) throw new StoreClosedError();
      if (db.inTransaction) return fn(writer);
      return db.transaction(() => fn(writer)).immediate();
    },
    appendEvent(input: EventInput): StoredEvent {
      return writer.transaction(() => {
        if (input.idempotency_key !== undefined) {
          const existing = byKey.get(input.type, input.idempotency_key) as EventRow | undefined;
          if (existing) return toStored(existing);
        }
        const { value, paths } = redactSecrets(input.payload);
        const payload: Record<string, unknown> = { ...value };
        if (paths.length) {
          const prior = Array.isArray(payload[REDACTION_KEY]) ? (payload[REDACTION_KEY] as unknown[]) : [];
          payload[REDACTION_KEY] = [...prior, ...paths];
        }
        const payloadText = canonicalJson(payload);
        if (hasSecretShape(payloadText)) {
          throw new SecretShapeError(
            'payload still looks like it carries a secret after redaction; not written',
          );
        }
        const h = head.get() as { seq: number; hash: string } | undefined;
        const id = newId('evt');
        const row: EventRow = {
          seq: (h?.seq ?? 0) + 1,
          id,
          ts: nowIso(now()),
          type: input.type,
          version: input.version ?? 1,
          actor_kind: input.actor_kind,
          actor_id: input.actor_id,
          project_id: input.project_id ?? null,
          stream_id: input.stream_id ?? null,
          work_order_id: input.work_order_id ?? null,
          run_id: input.run_id ?? null,
          correlation_id: input.correlation_id ?? newId('cor'),
          causation_id: input.causation_id ?? null,
          idempotency_key: input.idempotency_key ?? id,
          payload: payloadText,
          payload_hash: sha256Hex(payloadText),
          prev_hash: h?.hash ?? GENESIS_HASH,
          hash: '',
        };
        row.hash = envelopeHash(envelopeOf(row, JSON.parse(payloadText) as Record<string, unknown>));
        try {
          insert.run(row);
        } catch (e) {
          if (e instanceof Error && /secret-shaped/.test(e.message)) {
            throw new SecretShapeError('the secret tripwire trigger refused the payload; not written', {
              cause: e,
            });
          }
          throw e;
        }
        return toStored(row);
      });
    },
  };
  return writer;
}

function verify(db: DB): VerifyResult {
  let prev = GENESIS_HASH;
  let count = 0;
  for (const row of db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY seq`)
    .iterate() as Iterable<EventRow>) {
    const r = checkRow(row, prev, count + 1);
    if (!r.ok) return { ok: false, seq: row.seq, reason: r.reason, count };
    prev = row.hash;
    count++;
  }
  return { ok: true, count, head: prev };
}

/** Opens (and on first use migrates) the event store. See OpenStoreOptions and the Store port. */
export function openStore(opts: OpenStoreOptions): Store {
  const now = opts.now ?? (() => new Date());
  const schemaPath = opts.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const schemaText = readFileSync(schemaPath, 'utf8');
  const schemaSha = sha256Hex(readFileSync(schemaPath));
  const memory = opts.path === ':memory:';
  const readonly = opts.readonly === true;
  const lockPath = opts.lockPath ?? `${opts.path}.lock`;

  let open = true;
  const isOpen = () => open;
  let lock: WriterLock | undefined;
  let writerDb: DB | undefined;
  let writer: Writer | undefined;
  let readerDb: DB | undefined;
  let reader: Reader | undefined;

  const openWriter = (): Writer => {
    if (!memory) lock = acquireWriterLock(lockPath);
    try {
      const db = new Database(opts.path);
      try {
        configure(db, true);
        if (!hasSchemaMeta(db)) migrate(db, schemaText, schemaSha, now);
        checkSchemaHash(db, schemaSha, schemaPath);
      } catch (e) {
        db.close();
        throw e;
      }
      writerDb = db;
      writer = makeWriter(db, now, isOpen);
      return writer;
    } catch (e) {
      lock?.release();
      lock = undefined;
      throw e;
    }
  };

  if (memory) {
    if (readonly) throw new StoreClosedError('a read-only store needs a database file');
    openWriter();
  } else if (readonly || existsSync(opts.path)) {
    // Check the recorded schema hash without taking the writer lock.
    const probe = new Database(opts.path, { readonly: true, fileMustExist: true });
    try {
      const fresh = !hasSchemaMeta(probe);
      if (fresh && !readonly) {
        probe.close();
        openWriter();
      } else {
        checkSchemaHash(probe, schemaSha, schemaPath);
        probe.close();
      }
    } finally {
      if (probe.open) probe.close();
    }
  } else {
    openWriter();
  }

  const getReader = (): Reader => {
    if (!open) throw new StoreClosedError();
    if (reader) return reader;
    if (memory) {
      reader = makeReader(writerDb!, true, isOpen);
    } else {
      readerDb = new Database(opts.path, { readonly: true, fileMustExist: true });
      configure(readerDb, false);
      reader = makeReader(readerDb, true, isOpen);
    }
    return reader;
  };

  return {
    path: opts.path,
    get writer(): Writer | undefined {
      if (!open) throw new StoreClosedError();
      if (readonly) return undefined;
      return writer ?? openWriter();
    },
    reader: getReader,
    verifyChain(): VerifyResult {
      getReader();
      return verify(memory ? writerDb! : readerDb!);
    },
    close(): void {
      if (!open) return;
      open = false;
      readerDb?.close();
      writerDb?.close();
      lock?.release();
    },
  };
}
