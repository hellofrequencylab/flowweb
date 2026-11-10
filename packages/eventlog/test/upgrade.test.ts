// FW-C-003: forward-only upgrade of a database created from an earlier schema.core.sql.
// fixtures/schema.core-1.0.0-core.sql is a verbatim copy of schema.core.sql as released at
// 1.0.0-core (the first test proves it by hash), so these tests keep working after the repo-root
// file moves on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SCHEMA_PATH,
  MIGRATION_0001_KEY,
  MIGRATIONS_DIR,
  openStore,
  SCHEMA_HISTORY,
  SchemaMismatchError,
  SchemaUpgradeRequiredError,
  schemaVersionOf,
  sha256Hex,
  UPGRADES,
  type Writer,
} from '../src/index.ts';
import { ev, tempDir } from './helpers.ts';

const dir = tempDir();
const V1_0 = join(import.meta.dirname, 'fixtures/schema.core-1.0.0-core.sql');
const H64 = (c: string) => c.repeat(64);

/** A 1.0.0-core database with a small world in it: two runs, their steps, spend and events. */
function oldDb(name: string): string {
  const path = join(dir, name);
  const s = openStore({ path, schemaPath: V1_0 });
  const w = s.writer!;
  w.transaction((tx: Writer) => {
    tx.run("INSERT INTO projects(id,slug,name) VALUES ('prj_up1','up1','Upgrade')");
    for (const [id, role, vendor] of [
      ['agt_work1', 'worker', 'anthropic'],
      ['agt_veri1', 'verifier', 'openai'],
    ])
      tx.run("INSERT INTO agents(id,name,role,vendor,model,tier,status) VALUES (?,?,?,?,'m','L1','active')", [
        id,
        id,
        role,
        vendor,
      ]);
    tx.run(
      "INSERT INTO streams(id,project_id,key,name,template,definition,definition_hash,status) VALUES ('stm_up1','prj_up1','dev','Dev','backlog_dev','{}',?,'active')",
      [H64('a')],
    );
    tx.run(
      `INSERT INTO ledger_rows(id,project_id,stream_id,title,priority,lane,size,status,owner_kind,owner_id,probe_kind,
         probe_spec,probe_expected,probe_measures,probe_hash)
       VALUES ('lr_up1','prj_up1','stm_up1','Row','P1','kernel','S','claimed','agent','agt_work1','command','{}','{}','measures a thing',?)`,
      [H64('b')],
    );
    tx.run(
      `INSERT INTO work_orders(id,project_id,stream_id,ledger_row_id,title,body,content_hash,autonomy_tier,doer_agent_id,verifier_agent_id)
       VALUES ('wo_up1','prj_up1','stm_up1','lr_up1','WO','{}',?,'L2','agt_work1','agt_veri1')`,
      [H64('c')],
    );
    const run = `INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,attempt,adapter_name,adapter_vendor,status,failure_class,parent_run_id)
                 VALUES (?, 'wo_up1','prj_up1','stm_up1','agt_work1', ?, 'fake','other', ?, ?, ?)`;
    tx.run(run, ['run_up1', 1, 'failed', 'no_artifact', null]);
    tx.run(run, ['run_up2', 2, 'validating', null, 'run_up1']);
    tx.run(
      "INSERT INTO run_steps(id,run_id,seq,kind,started_at) VALUES ('stp_up1','run_up1',0,'prompt','2026-11-10T00:00:00.000Z')",
    );
    tx.run(
      "INSERT INTO spend_entries(id,run_id,agent_id,kind,usd,idempotency_key) VALUES ('spd_up1','run_up1','agt_work1','model_tokens',0.25,'k1')",
    );
    for (let i = 1; i <= 5; i++) tx.appendEvent(ev(i, { run_id: 'run_up1' }));
  });
  s.close();
  return path;
}

/** name -> sql of every table, index, trigger and view, so two databases can be compared. */
function objects(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true });
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ type: string; name: string; sql: string }>;
  db.close();
  // A rename writes the new name quoted ("runs"); that is the only difference a rebuild leaves.
  return Object.fromEntries(
    rows.map((r) => [`${r.type}:${r.name}`, r.sql.replace(/^CREATE TABLE "(\w+)"/, 'CREATE TABLE $1')]),
  );
}

const dump = (path: string, sql: string) => {
  const db = new Database(path, { readonly: true });
  const out = db.prepare(sql).all();
  db.close();
  return out;
};

describe('schema upgrade 1.0.0-core -> current', () => {
  test('the 1.0.0-core fixture is the released file, and the current file is the next version', () => {
    expect(sha256Hex(readFileSync(V1_0))).toBe(SCHEMA_HISTORY[0]?.sha256);
    expect(schemaVersionOf(readFileSync(V1_0, 'utf8'))).toBe('1.0.0-core');
    expect(schemaVersionOf(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'))).toBe(UPGRADES.at(-1)?.to);
    expect(UPGRADES.map((u) => u.id)).toEqual(['0002']);
  });

  test('rows, indexes, triggers and the event chain survive; the new failure class is accepted', () => {
    const path = oldDb('old.sqlite');
    const runsBefore = dump(path, 'SELECT * FROM runs ORDER BY id');
    const eventsBefore = dump(path, 'SELECT * FROM events ORDER BY seq');
    const stepsBefore = dump(path, 'SELECT * FROM run_steps');
    const spendBefore = dump(path, 'SELECT * FROM spend_entries');

    const s = openStore({ path });
    const w = s.writer!;
    expect(w.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")).toEqual({
      value: '1.1.0-core',
    });
    expect(w.get('SELECT value FROM schema_meta WHERE key = ?', [MIGRATION_0001_KEY])).toEqual({
      value: SCHEMA_HISTORY[0]?.sha256,
    });
    const file = readFileSync(join(MIGRATIONS_DIR, '0002-core-1.1.0.sql'));
    expect(w.get("SELECT value FROM schema_meta WHERE key = 'migration_0002_sha256'")).toEqual({
      value: sha256Hex(file),
    });
    expect(w.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(w.get('PRAGMA legacy_alter_table')).toEqual({ legacy_alter_table: 0 });
    expect(s.verifyChain()).toMatchObject({ ok: true, count: 5 });

    // the new value is accepted, through the run state machine (its trigger survived the rebuild)
    w.run("UPDATE runs SET status = 'failed', failure_class = 'policy' WHERE id = 'run_up2'");
    expect(() => w.run("UPDATE runs SET status = 'running' WHERE id = 'run_up2'")).toThrow(
      /illegal run transition/,
    );
    expect(() => w.run("UPDATE runs SET failure_class = 'bogus' WHERE id = 'run_up2'")).toThrow(/CHECK/);
    // foreign keys into and out of the rebuilt table still hold
    expect(() =>
      w.run(
        "INSERT INTO run_steps(id,run_id,seq,kind,started_at) VALUES ('stp_x','run_nope',0,'prompt','t')",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      w.run(
        "INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,attempt,adapter_name,adapter_vendor) VALUES ('run_x','wo_up1','prj_nope','stm_up1','agt_work1',3,'f','other')",
      ),
    ).toThrow(/FOREIGN KEY/);
    s.close();

    expect(dump(path, "SELECT * FROM runs WHERE id = 'run_up1'")).toEqual(runsBefore.slice(0, 1));
    expect(dump(path, "SELECT failure_class FROM runs WHERE id = 'run_up2'")).toEqual([
      { failure_class: 'policy' },
    ]);
    expect(dump(path, 'SELECT * FROM events ORDER BY seq')).toEqual(eventsBefore);
    expect(dump(path, 'SELECT * FROM run_steps')).toEqual(stepsBefore);
    expect(dump(path, 'SELECT * FROM spend_entries')).toEqual(spendBefore);

    // same tables, indexes, triggers and views as a database created fresh from the current file
    const fresh = join(dir, 'fresh.sqlite');
    openStore({ path: fresh }).close();
    expect(objects(path)).toEqual(objects(fresh));

    // opening again applies nothing and changes nothing
    const again = openStore({ path });
    expect(again.writer!.all("SELECT key FROM schema_meta WHERE key LIKE 'migration_0002%'")).toHaveLength(2);
    again.close();
  });

  test('the upgraded secret tripwire refuses a bare PKCS#8 header', () => {
    const path = oldDb('tripwire.sqlite');
    openStore({ path }).close();
    const db = new Database(path, { readonly: true });
    const sql = (
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'trg_events_no_secret_shapes'").get() as {
        sql: string;
      }
    ).sql;
    const glob = /GLOB '(\*BEGIN[^']*)'/.exec(sql)?.[1];
    expect(glob).toBe('*BEGIN *PRIVATE KEY*');
    const header = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    expect(db.prepare('SELECT ? GLOB ? AS hit').get(header, glob)).toEqual({ hit: 1 });
    expect(db.prepare('SELECT ? GLOB ? AS hit').get(`-----BEGIN RSA ${'PRIVATE KEY'}-----`, glob)).toEqual({
      hit: 1,
    });
    db.close();
  });

  test('a read-only open does not upgrade; it refuses and leaves the file at 1.0.0-core', () => {
    const path = oldDb('readonly.sqlite');
    expect(() => openStore({ path, readonly: true })).toThrow(SchemaUpgradeRequiredError);
    expect(dump(path, "SELECT value FROM schema_meta WHERE key = 'schema_version'")).toEqual([
      { value: '1.0.0-core' },
    ]);
  });

  test('a failed upgrade rolls back completely', () => {
    const path = oldDb('broken.sqlite');
    // a dangling reference written around the foreign keys: the post-upgrade check refuses it
    const raw = new Database(path);
    raw.pragma('foreign_keys = OFF');
    raw
      .prepare(
        "INSERT INTO run_steps(id,run_id,seq,kind,started_at) VALUES ('stp_bad','run_gone',0,'prompt','t')",
      )
      .run();
    raw.close();
    const before = objects(path);
    const runs = dump(path, 'SELECT * FROM runs ORDER BY id');
    expect(() => openStore({ path })).toThrow(/foreign key violation/);
    expect(objects(path)).toEqual(before);
    expect(dump(path, 'SELECT * FROM runs ORDER BY id')).toEqual(runs);
    expect(dump(path, "SELECT key FROM schema_meta WHERE key LIKE 'migration_0002%'")).toEqual([]);
    expect(dump(path, "SELECT value FROM schema_meta WHERE key = 'schema_version'")).toEqual([
      { value: '1.0.0-core' },
    ]);
  });

  test('a changed recorded upgrade hash is refused like a changed schema hash', () => {
    const path = oldDb('tamper.sqlite');
    openStore({ path }).close();
    const raw = new Database(path);
    raw.prepare("UPDATE schema_meta SET value = ? WHERE key = 'migration_0002_sha256'").run(H64('e'));
    raw.close();
    expect(() => openStore({ path })).toThrow(SchemaMismatchError);
    expect(() => openStore({ path, readonly: true })).toThrow(SchemaMismatchError);
  });
});
