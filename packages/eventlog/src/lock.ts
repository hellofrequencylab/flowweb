// Process-level single-writer lock: an exclusively created file next to the database that holds
// "<pid> <nonce>". A second writer fails fast with WriterLockError instead of waiting.
// A lock whose pid is no longer alive is stale and is taken over (rename away, check, recreate).
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { WriterLockError } from './errors.ts';

/** Lock paths held by this process, so two Stores in one process also exclude each other. */
const heldHere = new Set<string>();

export interface WriterLock {
  readonly path: string;
  release(): void;
}

function readLock(path: string): { text: string; pid: number | undefined } | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  const pid = Number.parseInt(text.split(/\s+/)[0] ?? '', 10);
  return { text, pid: Number.isInteger(pid) && pid > 0 ? pid : undefined };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  // A zombie (killed, not yet reaped) still answers kill(pid, 0) but holds nothing: on Linux, read
  // its state from /proc so a crashed holder whose parent never reaps it does not keep the lock.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false;
    } catch {
      // Gone between the two calls, or /proc unreadable: fall back to the kill(pid, 0) answer.
    }
  }
  return true;
}

export function acquireWriterLock(path: string): WriterLock {
  if (heldHere.has(path)) throw new WriterLockError(path, process.pid);
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const cur = readLock(path);
      if (!cur) continue; // released between our open and read: try again
      // A file we cannot parse is treated as held: refusing is the safe side.
      if (cur.pid === undefined || isAlive(cur.pid)) throw new WriterLockError(path, cur.pid);
      // Stale. Move it aside atomically; only one taker's rename succeeds.
      const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        renameSync(path, aside);
      } catch (re) {
        if ((re as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw re;
      }
      const moved = readLock(aside);
      if (moved?.text !== cur.text) {
        // Someone else took over between our read and our rename: put their live lock back.
        renameSync(aside, path);
        throw new WriterLockError(path, moved?.pid);
      }
      unlinkSync(aside);
      continue;
    }
    try {
      writeSync(fd, mine);
    } finally {
      closeSync(fd);
    }
    heldHere.add(path);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      heldHere.delete(path);
      process.off('exit', release);
      try {
        if (readLock(path)?.text === mine) unlinkSync(path);
      } catch {
        // Best effort: a lock we cannot remove is stale once this pid exits.
      }
    };
    process.on('exit', release);
    return { path, release };
  }
  throw new WriterLockError(path, readLock(path)?.pid);
}
