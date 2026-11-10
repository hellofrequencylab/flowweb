// FW-C-029: fw backup / fw restore. A backup is one tar file holding a consistent copy of the
// database (SQLite VACUUM INTO, taken under the writer lock), the home's config, policy and flows,
// and a manifest with the database hash. Credentials (creds/), pairing tokens and run directories
// are never copied: a restored home re-adds its keys, and `fw doctor` says when none are present.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openStore, sha256Hex, type Writer } from '@fw/eventlog';

/** Directories of the home that a backup carries, besides the database. */
export const BACKUP_DIRS = ['config', 'policy', 'flows'] as const;
const DB_IN_TAR = 'db/fw.sqlite';
const MANIFEST = 'fw-backup.json';

export interface BackupResult {
  path: string;
  db_hash: string;
  bytes: number;
  event_seq: number;
}

export interface RestoreResult {
  home: string;
  db_hash: string;
  events: number;
  dirs: string[];
}

export class BackupError extends Error {
  constructor(
    readonly code: 'BACKUP_FAILED' | 'RESTORE_REFUSED' | 'RESTORE_FAILED',
    message: string,
  ) {
    super(message);
  }
}

const fileHash = (p: string) => sha256Hex(readFileSync(p));

function tar(args: string[]): void {
  try {
    execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const err = (e as { stderr?: Buffer }).stderr?.toString().trim();
    throw new BackupError('BACKUP_FAILED', `tar ${args[0]} failed: ${err || (e as Error).message}`);
  }
}

/**
 * Writes the backup to `out` and appends one system.backup_completed event. `writer` is the
 * home's database writer: holding it is what keeps the copy consistent.
 */
export function createBackup(home: string, writer: Writer, out: string): BackupResult {
  const target = resolve(out);
  const stage = mkdtempSync(join(tmpdir(), 'fw-backup-'));
  try {
    mkdirSync(join(stage, 'db'));
    const copy = join(stage, DB_IN_TAR);
    writer.run('VACUUM INTO ?', [copy]);
    const db_hash = fileHash(copy);
    const dirs = BACKUP_DIRS.filter((d) => existsSync(join(home, d)));
    for (const d of dirs) cpSync(join(home, d), join(stage, d), { recursive: true });
    writeFileSync(
      join(stage, MANIFEST),
      `${JSON.stringify({ format: 1, created_at: new Date().toISOString(), db_hash, dirs }, null, 2)}\n`,
    );
    mkdirSync(dirname(target), { recursive: true });
    tar(['-cf', target, '-C', stage, MANIFEST, 'db', ...dirs]);
    const bytes = statSync(target).size;
    const ev = writer.appendEvent({
      type: 'system.backup_completed',
      actor_kind: 'system',
      actor_id: 'fw.backup',
      payload: { backup_ref: target, db_hash, bytes },
    });
    return { path: target, db_hash, bytes, event_seq: ev.seq };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Restores a backup into a home that has no database yet, then re-verifies the event chain. */
export function restoreBackup(home: string, dbFile: string, file: string): RestoreResult {
  const src = resolve(file);
  if (!existsSync(src)) throw new BackupError('RESTORE_REFUSED', `no backup file at ${src}`);
  if (existsSync(dbFile))
    throw new BackupError(
      'RESTORE_REFUSED',
      `${dbFile} already exists; restore only into a home with no database`,
    );
  const stage = mkdtempSync(join(tmpdir(), 'fw-restore-'));
  try {
    tar(['-xf', src, '-C', stage]);
    const mPath = join(stage, MANIFEST);
    if (!existsSync(mPath) || !existsSync(join(stage, DB_IN_TAR)))
      throw new BackupError('RESTORE_FAILED', `${src} is not an fw backup (no ${MANIFEST} or database)`);
    const manifest = JSON.parse(readFileSync(mPath, 'utf8')) as { db_hash: string; dirs: string[] };
    const db_hash = fileHash(join(stage, DB_IN_TAR));
    if (db_hash !== manifest.db_hash)
      throw new BackupError('RESTORE_FAILED', 'the database in the backup does not match its recorded hash');
    const check = openStore({ path: join(stage, DB_IN_TAR), readonly: true });
    const chain = check.verifyChain();
    check.close();
    if (!chain.ok)
      throw new BackupError(
        'RESTORE_FAILED',
        `the event chain in the backup breaks at seq ${chain.seq}: ${chain.reason}`,
      );
    const dirs = (manifest.dirs ?? []).filter((d) => (BACKUP_DIRS as readonly string[]).includes(d));
    for (const d of dirs) cpSync(join(stage, d), join(home, d), { recursive: true });
    mkdirSync(dirname(dbFile), { recursive: true });
    cpSync(join(stage, DB_IN_TAR), dbFile);
    return { home, db_hash, events: chain.count, dirs };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
