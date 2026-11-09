// FW-C-003 (migration runner, connections) and FW-C-004 (single writer lock).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SCHEMA_PATH,
  ForbiddenStatementError,
  MIGRATION_0001_KEY,
  openStore,
  PACKAGE,
  SchemaMismatchError,
  sha256Hex,
  WriterLockError,
} from '../src/index.ts';
import { ev, REPO_ROOT, seededDb, tempDir, withStore } from './helpers.ts';

const dir = tempDir();
const FIXTURE = join(import.meta.dirname, 'fixtures/second-writer.ts');

function runChild(path: string): Promise<{ code: number | null; out: Record<string, unknown>; ms: number }> {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [FIXTURE, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`second writer hung (stderr: ${stderr})`));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        done({ code, out: JSON.parse(stdout.trim().split('\n').pop() ?? '{}'), ms: Date.now() - t0 });
      } catch {
        fail(new Error(`bad child output: ${stdout} ${stderr}`));
      }
    });
  });
}

test('@fw/eventlog resolves', () => {
  expect(PACKAGE).toBe('@fw/eventlog');
});

describe('migration 0001', () => {
  test('the default schema path is the repo-root schema.core.sql', () => {
    expect(DEFAULT_SCHEMA_PATH).toBe(join(REPO_ROOT, 'schema.core.sql'));
  });

  test('a fresh database is WAL, records the schema sha256, and has foreign keys on everywhere', () => {
    const path = join(dir, 'fresh.sqlite');
    const store = openStore({ path });
    const w = store.writer!;
    const sha = sha256Hex(readFileSync(DEFAULT_SCHEMA_PATH));
    expect(w.get('SELECT value FROM schema_meta WHERE key = ?', [MIGRATION_0001_KEY])).toEqual({
      value: sha,
    });
    expect(w.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(w.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(store.reader().get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(w.get('SELECT value FROM schema_meta WHERE key = ?', ['schema_version'])).toEqual({
      value: '1.0.0-core',
    });
    store.close();
    withStore(path, (s) => expect(s.reader().get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 }), true);
  });

  test('the store refuses to switch foreign keys off or drop a trigger', () => {
    const store = openStore({ path: ':memory:' });
    const w = store.writer!;
    expect(() => w.run('PRAGMA foreign_keys = OFF')).toThrow(ForbiddenStatementError);
    expect(() => w.run('pragma main.foreign_keys=0')).toThrow(ForbiddenStatementError);
    expect(() => w.run('PRAGMA writable_schema = 1')).toThrow(ForbiddenStatementError);
    expect(() => w.run('DROP TRIGGER trg_events_no_update')).toThrow(ForbiddenStatementError);
    expect(() => store.reader().all('PRAGMA foreign_keys = OFF')).toThrow(ForbiddenStatementError);
    expect(w.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    store.close();
  });

  test('a reader cannot write', () => {
    const write = "INSERT INTO settings(key,value,updated_by) VALUES ('k','1','x') RETURNING key";
    const path = seededDb(dir, 'reader.sqlite', 1);
    withStore(path, (s) => {
      expect(() => s.reader().get(write)).toThrow(ForbiddenStatementError);
      expect(s.reader().all('SELECT seq FROM events')).toEqual([{ seq: 1 }]);
    });
    // Behind the guard, the reader's connection itself is read-only.
    const raw = new Database(path, { readonly: true });
    expect(() => raw.prepare(write).get()).toThrow(/readonly/i);
    raw.close();
    const mem = openStore({ path: ':memory:' });
    expect(() => mem.reader().get(write)).toThrow(ForbiddenStatementError);
    expect(mem.writer!.get(write)).toEqual({ key: 'k' });
    mem.close();
  });

  test('reopening an existing database does not re-apply the migration', () => {
    const path = seededDb(dir, 'reopen.sqlite', 3);
    withStore(path, (s) => {
      expect(s.writer!.appendEvent(ev(4)).seq).toBe(4);
      expect(s.verifyChain()).toMatchObject({ ok: true, count: 4 });
    });
  });

  test('a schema file whose sha256 differs from the recorded one is refused', () => {
    const path = seededDb(dir, 'drift.sqlite', 2);
    const edited = join(dir, 'schema.edited.sql');
    writeFileSync(edited, `${readFileSync(DEFAULT_SCHEMA_PATH, 'utf8')}\n-- one more line\n`);
    expect(() => openStore({ path, schemaPath: edited })).toThrow(SchemaMismatchError);
    expect(() => openStore({ path, schemaPath: edited, readonly: true })).toThrow(SchemaMismatchError);
    // The refusal happens before the writer lock is taken.
    expect(existsSync(`${path}.lock`)).toBe(false);
    withStore(path, (s) => expect(s.verifyChain()).toMatchObject({ ok: true, count: 2 }));
  });

  test('a recorded hash that was changed in the database is refused', () => {
    const path = seededDb(dir, 'meta-edit.sqlite', 1);
    const raw = new Database(path);
    raw.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('0'.repeat(64), MIGRATION_0001_KEY);
    raw.close();
    let err: unknown;
    try {
      openStore({ path });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect((err as SchemaMismatchError).code).toBe('SCHEMA_MISMATCH');
    expect((err as SchemaMismatchError).recorded).toBe('0'.repeat(64));
  });

  test('a database built without the runner (no recorded hash) is refused', () => {
    const path = join(dir, 'unrecorded.sqlite');
    const raw = new Database(path);
    raw.exec(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'));
    raw.close();
    expect(() => openStore({ path })).toThrow(SchemaMismatchError);
  });
});

describe('single writer', () => {
  test('a second writer process fails fast with WriterLockError and no event is lost or duplicated', async () => {
    const path = seededDb(dir, 'locked.sqlite', 0);
    const store = openStore({ path });
    const w = store.writer!;
    for (let i = 1; i <= 10; i++) w.appendEvent(ev(i));

    const child = await runChild(path);
    expect(child.code).toBe(3);
    expect(child.out).toMatchObject({ result: 'locked', code: 'LOCKED', holderPid: process.pid });
    expect(child.ms).toBeLessThan(10_000);

    for (let i = 11; i <= 20; i++) w.appendEvent(ev(i));
    expect(store.verifyChain()).toMatchObject({ ok: true, count: 20 });
    store.close();
    expect(existsSync(`${path}.lock`)).toBe(false);

    // Once the lock is released the other process can write, and the chain stays whole.
    const again = await runChild(path);
    expect(again.out).toMatchObject({ result: 'appended', seq: 21 });
    withStore(path, (s) => expect(s.verifyChain()).toMatchObject({ ok: true, count: 21 }), true);
  });

  test('a second writer in the same process is refused; a read-only store still reads', () => {
    const path = seededDb(dir, 'same-process.sqlite', 2);
    const a = openStore({ path });
    a.writer!.appendEvent(ev(3));
    const b = openStore({ path });
    expect(() => b.writer).toThrow(WriterLockError);
    const ro = openStore({ path, readonly: true });
    expect(ro.writer).toBeUndefined();
    expect(ro.verifyChain()).toMatchObject({ ok: true, count: 3 });
    ro.close();
    b.close();
    a.close();
  });

  test('a stale lock left by a dead process is taken over', () => {
    const path = seededDb(dir, 'stale.sqlite', 1);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    writeFileSync(`${path}.lock`, `${dead.stdout} deadbeef\n`);
    withStore(path, (s) => {
      expect(s.writer!.appendEvent(ev(2)).seq).toBe(2);
      expect(readFileSync(`${path}.lock`, 'utf8').split(' ')[0]).toBe(String(process.pid));
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test('a lock file held by a live process is respected even if this process never saw it', () => {
    const path = seededDb(dir, 'foreign-lock.sqlite', 1);
    writeFileSync(`${path}.lock`, `${process.ppid} cafe\n`);
    const s = openStore({ path });
    let err: unknown;
    try {
      void s.writer;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriterLockError);
    expect((err as WriterLockError).holderPid).toBe(process.ppid);
    s.close();
    expect(existsSync(`${path}.lock`)).toBe(true); // not ours, not removed
  });
});
