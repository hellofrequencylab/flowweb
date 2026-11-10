// Forward-only schema upgrades. schema.core.sql is always the current schema and creates a new
// database (migration 0001). A database created from an earlier schema.core.sql is recognised by
// the sha256 it recorded for 0001 and brought forward by the upgrade files in
// packages/contracts/sql/migrations/ (Tier 0), each in one transaction, each recorded by its own
// sha256 so a changed upgrade file is refused like a changed schema file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { SchemaMismatchError } from './errors.ts';
import { nowIso, sha256Hex } from './util.ts';

type DB = Database.Database;

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../contracts/sql/migrations');

/** Every released schema.core.sql a database may have been created from, with the version it set. */
export const SCHEMA_HISTORY: ReadonlyArray<{ version: string; sha256: string }> = [
  { version: '1.0.0-core', sha256: '4bd8439572bddb346924f14e2e9d6c33852040c841a433ccc81ac869387b54f3' },
  { version: '1.1.0-core', sha256: '2bc80cccb1c6d7b01e3e86e0da4d3de79d5e739f3bccac5a89d2d94d9aaa0831' },
];

export interface Upgrade {
  /** Migration number; recorded as migration_<id>_sha256 and migration_<id>_applied_at. */
  id: string;
  from: string;
  to: string;
  /** File name under MIGRATIONS_DIR. */
  file: string;
}

/** In order. Each takes a database at `from` to `to`; never edited once released. */
export const UPGRADES: readonly Upgrade[] = [
  { id: '0002', from: '1.0.0-core', to: '1.1.0-core', file: '0002-core-1.1.0.sql' },
  { id: '0003', from: '1.1.0-core', to: '1.2.0-core', file: '0003-core-1.2.0.sql' },
];

export const migrationKey = (id: string) => `migration_${id}_sha256`;

/** schema_version a schema file sets in its schema_meta seed. */
export function schemaVersionOf(schemaText: string): string | undefined {
  return /\('schema_version'\s*,\s*'([^']+)'\)/.exec(schemaText)?.[1];
}

function meta(db: DB, key: string): string | undefined {
  return (db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value;
}

export interface UpgradePlan {
  /** Upgrades still to apply, in order (empty when the database is current). */
  pending: Array<Upgrade & { sql: string; sha256: string }>;
}

/**
 * Checks a database against the schema file and says which upgrades it still needs. Throws
 * SchemaMismatchError when the recorded 0001 hash is neither the current file nor a released one,
 * when an applied upgrade's recorded hash differs from its file, or when no upgrade path reaches
 * the current schema version.
 */
export function planUpgrades(
  db: DB,
  schemaSha: string,
  schemaText: string,
  schemaPath: string,
  recorded0001: string | undefined,
  dir: string = MIGRATIONS_DIR,
): UpgradePlan {
  if (recorded0001 === schemaSha) return { pending: [] };
  const born = SCHEMA_HISTORY.find((h) => h.sha256 === recorded0001);
  const target = schemaVersionOf(schemaText);
  if (!born || !target) throw new SchemaMismatchError(recorded0001, schemaSha, schemaPath);
  const pending: UpgradePlan['pending'] = [];
  let at = born.version;
  for (const u of UPGRADES) {
    if (at === target) break;
    if (u.from !== at) continue;
    const bytes = readFileSync(resolve(dir, u.file));
    const sha256 = sha256Hex(bytes);
    const applied = meta(db, migrationKey(u.id));
    if (applied === undefined) pending.push({ ...u, sql: bytes.toString('utf8'), sha256 });
    else if (applied !== sha256) throw new SchemaMismatchError(applied, sha256, resolve(dir, u.file), u.id);
    at = u.to;
  }
  if (at !== target) throw new SchemaMismatchError(recorded0001, schemaSha, schemaPath);
  return { pending };
}

/**
 * Applies one upgrade in a single transaction. Foreign keys are off and legacy_alter_table on while
 * it runs (a table rebuild needs both, and neither can change inside a transaction); both are put
 * back afterwards whatever happens. Before COMMIT: no foreign key violations, schema_version is the
 * upgrade's `to`, and the file's hash is recorded.
 */
export function applyUpgrade(db: DB, u: UpgradePlan['pending'][number], now: Date): void {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(u.sql);
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length) {
        throw new Error(`migration ${u.id}: ${violations.length} foreign key violation(s) after upgrade`);
      }
      const version = meta(db, 'schema_version');
      if (version !== u.to) throw new Error(`migration ${u.id}: schema_version is ${version}, want ${u.to}`);
      db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?), (?, ?)').run(
        migrationKey(u.id),
        u.sha256,
        `migration_${u.id}_applied_at`,
        nowIso(now),
      );
      db.exec('COMMIT');
    } catch (e) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }
}
