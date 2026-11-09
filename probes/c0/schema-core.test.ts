// Probe c0/schema-core (FW-C-003; backlog verify_probe kernel/schema-core).
// Surface: openStore({ path }) from packages/eventlog/src/index.ts, and the database file read with
// node:sqlite.
// Acceptance:
//   - a fresh database created by the runner has every table, view and trigger of schema.core.sql
//     (the same objects the 54 schema tests exercise) and records the sha256 of schema.core.sql
//   - the store never hands out a connection with foreign_keys off (writer and reader both report 1),
//     and the file is in WAL mode
//   - the runner refuses to open a database whose recorded migration hash differs from the file
// Note: "passes tests/schema_core_test.py" is checked by CI's schema job against schema.core.sql;
// this probe checks the runner applied exactly that schema.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { freshHome, requireExport, root, sha256, storePath } from './_lib.mjs';

type Store = {
  writer: { get: (sql: string) => Record<string, unknown> | undefined } | undefined;
  reader: () => { get: (sql: string) => Record<string, unknown> | undefined };
  close: () => void;
};
type OpenStore = (o: { path: string; readonly?: boolean }) => Store | Promise<Store>;

const schemaSql = readFileSync(join(root, 'schema.core.sql'), 'utf8');

function objects(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','view','trigger','index') AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => `${r.type}:${r.name}`)
    .sort();
}

describe('c0/schema-core', () => {
  test('fresh store applies schema.core.sql exactly, records its hash, WAL and foreign keys on', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-003')) as OpenStore;
    const home = freshHome('schema');
    const path = storePath(home);
    const store = await openStore({ path });
    const w = store.writer;
    expect(w, 'a read-write store has a writer').toBeTruthy();
    expect(Number(Object.values(w!.get('PRAGMA foreign_keys') ?? {})[0]), 'writer foreign_keys').toBe(1);
    expect(Number(Object.values(store.reader().get('PRAGMA foreign_keys') ?? {})[0]), 'reader foreign_keys').toBe(1);
    store.close();

    const ref = new DatabaseSync(':memory:');
    ref.exec(schemaSql);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(String(Object.values(db.prepare('PRAGMA journal_mode').get() ?? {})[0]).toLowerCase()).toBe('wal');
    const got = objects(db).filter((o) => !o.startsWith('table:fw_') && !o.includes('migration'));
    expect(got, 'same tables, views, indexes and triggers as schema.core.sql').toEqual(objects(ref));
    const meta = db.prepare('SELECT key, value FROM schema_meta').all();
    const hash = sha256(schemaSql);
    expect(
      meta.some((r) => r.value === hash),
      `schema_meta records sha256(schema.core.sql) = ${hash}`,
    ).toBe(true);
    db.close();
  });

  test('a changed migration hash is refused on open', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-003')) as OpenStore;
    const home = freshHome('schema-tamper');
    const path = storePath(home);
    (await openStore({ path })).close();
    const db = new DatabaseSync(path);
    const hash = sha256(schemaSql);
    const changed = db.prepare('UPDATE schema_meta SET value = ? WHERE value = ?').run('f'.repeat(64), hash);
    expect(Number(changed.changes), 'the recorded hash row exists').toBe(1);
    db.close();
    await expect(
      (async () => {
        const s = await openStore({ path });
        s.close();
      })(),
      'openStore must refuse a database whose migration hash differs',
    ).rejects.toThrow();
  });
});
