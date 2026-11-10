// The query registry: read-only, parameterised, hashed, and closed to SQL from the caller.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { QUERIES, runQuery } from '../src/queries/index.ts';
import { fileStore, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();
const store = fileStore(dir);
const project = syncInto(store, writeRows(join(dir, 'rows'), [row('FW-C-942'), row('FW-C-943')])).project_id!;
const r = store.reader();
const day = { project, from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' };

describe('query registry', () => {
  test('every query is a single read-only SELECT with a unique id', () => {
    expect(new Set(QUERIES.map((q) => q.id)).size).toBe(QUERIES.length);
    for (const q of QUERIES) {
      expect(q.sql).toMatch(/^\s*SELECT\b/i);
      expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i);
      expect(q.sql).not.toContain(';');
    }
  });

  test('every query runs over a project and period, and the hash is stable', () => {
    for (const q of QUERIES) {
      const a = runQuery(r, q.id, day);
      expect(a.rows.length).toBeGreaterThan(0);
      expect(runQuery(r, q.id, day).result_hash).toBe(a.result_hash);
    }
    expect(runQuery(r, 'activity', day).rows[0]).toMatchObject({ rows_created: 2 });
    expect(runQuery(r, 'activity', { ...day, from: day.to }).rows[0]).toMatchObject({ events: 0 });
  });

  test('an unknown id is refused', () => {
    expect(() => runQuery(r, 'DROP TABLE events', day)).toThrow(/unknown query/);
  });
});
