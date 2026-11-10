import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore, type Store } from '@fw/eventlog';
import { afterAll } from 'vitest';
import { syncRows } from '../src/index.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const BACKLOG = join(REPO_ROOT, 'ledger/backlog/CORE-BACKLOG.json');
export const PROJECT = { slug: 'test-project', name: 'Test project' };

export type BacklogRow = Record<string, unknown> & { id: string };

export function backlogRows(): BacklogRow[] {
  return (JSON.parse(readFileSync(BACKLOG, 'utf8')) as { rows: BacklogRow[] }).rows;
}

/** A fresh temp directory removed after the test file finishes. */
export function tempDir(prefix = 'fw-ledger-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes row definition files (status stripped, as row files never carry it) into dir. */
export function writeRows(dir: string, rows: BacklogRow[]): string {
  mkdirSync(dir, { recursive: true });
  for (const r of rows) {
    const { status: _status, ...def } = r;
    writeFileSync(join(dir, `${r.id}.json`), `${JSON.stringify(def, null, 2)}\n`);
  }
  return dir;
}

/** Fixture row files for every row of CORE-BACKLOG.json. */
export function fixtureRows(dir: string): string {
  return writeRows(dir, backlogRows());
}

export function row(id: string, extra: Partial<BacklogRow> = {}): BacklogRow {
  return {
    id,
    title: `Test row ${id}`,
    priority: 'P1',
    size: 'S',
    lane: 'test',
    depends_on: [],
    verify_probe: 'sh check.sh',
    acceptance: ['The marker file exists after the change'],
    files_hint: ['src/**'],
    agent_suitability: 'agent',
    core_milestone: 'C0',
    ...extra,
  };
}

export function fileStore(dir: string, name = 'fw.sqlite'): Store {
  return openStore({ path: join(dir, name) });
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A temp git repo whose check.sh passes only when done.txt exists (so the probe fails until the
 * "work" is committed). Returns the repo dir and a commit helper.
 */
export function gitRepo(parent: string, name = 'repo') {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', 'test']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'check.sh'), 'echo checking; test -f done.txt\n');
  const commit = (msg: string) => {
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', msg]);
    return sh(dir, 'git', ['rev-parse', 'HEAD']);
  };
  const base = commit('base');
  return { dir, base, commit };
}

/** A FW_HOME with the core policy installed (the work-order compiler reads its size table). */
export function fwHome(parent: string): string {
  const home = join(parent, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'contracts-core/core-policy.yaml'), join(home, 'config/core-policy.yaml'));
  return home;
}

/**
 * Every table's rows as canonical text, for "the database did not change" checks. With eventsUpTo,
 * events after that seq are left out (to check that only new events were appended).
 */
export function dumpTables(store: Store, opts: { eventsUpTo?: number } = {}): string {
  const r = store.reader();
  const tables = r
    .all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((t) => t.name);
  return tables
    .map((t) => {
      const upTo = t === 'events' && opts.eventsUpTo !== undefined ? ` WHERE seq <= ${opts.eventsUpTo}` : '';
      return `${t}\n${JSON.stringify(r.all(`SELECT * FROM "${t}"${upTo} ORDER BY rowid`))}`;
    })
    .join('\n');
}

/** Syncs the given rows into a store and returns the report. */
export function syncInto(store: Store, rowsDir: string) {
  return syncRows(store.writer!, { rowsDir, project: PROJECT });
}

/** Runs python3 sqlite against a closed database file (to simulate tampering that bypasses the store). */
export function rawSql(dbFile: string, sql: string): void {
  const r = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.executescript(sys.argv[2])\nc.commit()',
      dbFile,
      sql,
    ],
    {
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) throw new Error(`python3 sqlite failed: ${r.stderr}`);
}
