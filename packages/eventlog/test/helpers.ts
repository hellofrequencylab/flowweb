import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';
import { type EventInput, openStore, type Store } from '../src/index.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** A fresh temp directory removed after the test file finishes. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fw-eventlog-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function ev(i: number, extra: Partial<EventInput> = {}): EventInput {
  return {
    type: 'system.started',
    actor_kind: 'system',
    actor_id: 'fwd',
    payload: { i, note: `event number ${i}` },
    ...extra,
  };
}

/** Creates a file store at dir/name holding n events and closes it. Returns the db path. */
export function seededDb(dir: string, name: string, n: number): string {
  const path = join(dir, name);
  const store = openStore({ path });
  store.writer!.transaction((w) => {
    for (let i = 1; i <= n; i++) w.appendEvent(ev(i));
  });
  store.close();
  return path;
}

/** Copies a closed database file (WAL is checkpointed on close) to a new name in the same dir. */
export function copyDb(src: string, dst: string): string {
  copyFileSync(src, dst);
  return dst;
}

export function withStore<T>(path: string, fn: (s: Store) => T, readonly = false): T {
  const s = openStore({ path, readonly });
  try {
    return fn(s);
  } finally {
    s.close();
  }
}
