// FW-C-005: ledger sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@fw/contracts';
import { describe, expect, test } from 'vitest';
import {
  analyzeGraph,
  codeFromRowId,
  getDbRow,
  parseRowDefinition,
  probeFromDefinition,
  probeHash,
  rowIdFromCode,
  syncRows,
  toContract,
} from '../src/index.ts';
import {
  backlogRows,
  dumpTables,
  fileStore,
  fixtureRows,
  PROJECT,
  row,
  syncInto,
  tempDir,
  writeRows,
} from './helpers.ts';

const dir = tempDir();

describe('importing CORE-BACKLOG.json', () => {
  const rowsDir = fixtureRows(join(dir, 'all-rows'));
  const store = fileStore(dir, 'all.sqlite');
  const report = syncInto(store, rowsDir);

  test('all 67 rows import as open and the dependency graph is acyclic', () => {
    expect(report.refused).toEqual([]);
    expect(report.applied).toBe(true);
    expect(report.created).toHaveLength(67);
    expect(report.graph.acyclic).toBe(true);
    expect(report.graph.cycles).toEqual([]);
    expect(report.graph.rows).toBe(67);
    const statuses = store
      .reader()
      .all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM ledger_rows GROUP BY status');
    expect(statuses).toEqual([{ status: 'open', n: 67 }]);
  });

  test('every stored row is a valid ledger-row contract object with its code derivable from the id', () => {
    for (const r of backlogRows()) {
      const db = getDbRow(store.reader(), r.id);
      expect(codeFromRowId(db.id)).toBe(r.id);
      const check = validate('ledger-row', toContract(db));
      expect(check.errors).toEqual([]);
      expect(db.probe_hash).toBe(toContract(db).probe.content_hash);
    }
  });

  test('each new row has a ledger.row_created event, and bootstrap emits one event per thing it created', () => {
    const r = store.reader();
    const count = (type: string) =>
      r.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE type = ?', [type])?.n;
    expect(count('ledger.row_created')).toBe(67);
    expect(count('project.created')).toBe(1);
    expect(count('stream.created')).toBe(1);
    expect(count('agent.registered')).toBe(3);
    const ev = r.get<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'ledger.row_created' AND json_extract(payload, '$.ledger_row_id') = 'lr_FWC005'",
    );
    expect(JSON.parse(ev!.payload)).toMatchObject({ code: 'FW-C-005', priority: 'P0', lane: 'kernel' });
    expect(store.verifyChain().ok).toBe(true);
  });

  test('a second sync with the same files is a no-op: nothing created, no event written', () => {
    const before = dumpTables(store);
    const again = syncInto(store, rowsDir);
    expect(again.created).toEqual([]);
    expect(again.unchanged).toHaveLength(67);
    expect(again.refused).toEqual([]);
    expect(dumpTables(store)).toBe(before);
  });

  test('status is never read from row files: a file that carries status is refused', () => {
    const d = join(dir, 'with-status');
    writeRows(d, [row('FW-C-950')]);
    const p = join(d, 'FW-C-950.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), status: 'done' }));
    const s = fileStore(dir, 'status.sqlite');
    const rep = syncInto(s, d);
    expect(rep.applied).toBe(false);
    expect(rep.refused[0]).toMatchObject({ code: 'FW-C-950', reason: 'invalid' });
    expect(rep.refused[0]!.message).toMatch(/never carry status/);
    expect(s.reader().get('SELECT COUNT(*) AS n FROM ledger_rows')).toEqual({ n: 0 });
    s.close();
  });
});

describe('a changed probe is refused and nothing changes', () => {
  test('editing the probe path of a synced row: refused with the id and both hashes, database content unchanged', () => {
    const rowsDir = fixtureRows(join(dir, 'tamper-rows'));
    const store = fileStore(dir, 'tamper.sqlite');
    syncInto(store, rowsDir);
    const file = join(rowsDir, 'FW-C-005.json');
    const def = JSON.parse(readFileSync(file, 'utf8'));
    const oldHash = getDbRow(store.reader(), 'FW-C-005').probe_hash;
    def.verify_probe = 'pnpm probe kernel/ledger-sync-elsewhere';
    writeFileSync(file, JSON.stringify(def));
    // A new row in the same sync must not be created either: all or nothing.
    writeRows(rowsDir, [row('FW-C-951')]);
    const before = dumpTables(store);
    const rep = syncInto(store, rowsDir);
    expect(rep.applied).toBe(false);
    expect(rep.created).toEqual([]);
    expect(rep.refused).toEqual([
      expect.objectContaining({
        code: 'FW-C-005',
        id: 'lr_FWC005',
        reason: 'probe_changed',
        stored_hash: oldHash,
        file_hash: probeHash(probeFromDefinition(def)),
      }),
    ]);
    expect(rep.refused[0]!.file_hash).not.toBe(oldHash);
    expect(dumpTables(store)).toBe(before);
    store.close();
  });
});

describe('dependency graph', () => {
  test('a cycle is reported and refuses the sync', () => {
    const d = writeRows(join(dir, 'cycle'), [
      row('FW-C-901', { depends_on: ['FW-C-903'] }),
      row('FW-C-902', { depends_on: ['FW-C-901'] }),
      row('FW-C-903', { depends_on: ['FW-C-902'] }),
      row('FW-C-904', { depends_on: ['FW-C-901'] }),
    ]);
    const s = fileStore(dir, 'cycle.sqlite');
    const rep = syncInto(s, d);
    expect(rep.applied).toBe(false);
    expect(rep.graph.acyclic).toBe(false);
    expect(rep.graph.cycles).toEqual([['FW-C-901', 'FW-C-902', 'FW-C-903']]);
    expect(rep.refused).toEqual([
      expect.objectContaining({ reason: 'cycle', cycle: ['FW-C-901', 'FW-C-902', 'FW-C-903'] }),
    ]);
    expect(s.reader().get('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 0 });
    s.close();
  });

  test('an unknown dependency is refused', () => {
    const d = writeRows(join(dir, 'unknown'), [row('FW-C-905', { depends_on: ['FW-C-999'] })]);
    const s = fileStore(dir, 'unknown.sqlite');
    const rep = syncInto(s, d);
    expect(rep.refused).toEqual([
      expect.objectContaining({ code: 'FW-C-905', reason: 'unknown_dependency' }),
    ]);
    s.close();
  });

  test('dependencies may point at rows already in the ledger', () => {
    const s = fileStore(dir, 'incremental.sqlite');
    expect(syncInto(s, writeRows(join(dir, 'inc-a'), [row('FW-C-906')])).created).toEqual(['FW-C-906']);
    const rep = syncInto(s, writeRows(join(dir, 'inc-b'), [row('FW-C-907', { depends_on: ['FW-C-906'] })]));
    expect(rep.created).toEqual(['FW-C-907']);
    s.close();
  });

  test('analyzeGraph finds self loops and separate cycles', () => {
    const g = analyzeGraph(
      new Map([
        ['A', ['A']],
        ['B', ['C']],
        ['C', ['B']],
        ['D', []],
      ]),
    );
    expect(g.cycles).toEqual([['A'], ['B', 'C']]);
    expect(g.acyclic).toBe(false);
  });
});

describe('row definitions and ids', () => {
  test('ids map to and from codes for every backlog row', () => {
    for (const r of backlogRows()) {
      const id = rowIdFromCode(r.id);
      expect(id).toMatch(/^lr_[0-9A-Za-z]{4,40}$/);
      expect(codeFromRowId(id)).toBe(r.id);
    }
    expect(rowIdFromCode('FW-C-019')).toBe('lr_FWC019');
    expect(rowIdFromCode('WS-P0-016')).toBe('lr_WSP0016');
    expect(() => rowIdFromCode('fw-c-19')).toThrow(/not a row code/);
  });

  test('the probe hash depends only on the probe, not on the rest of the row', () => {
    const a = parseRowDefinition(row('FW-C-908'));
    const b = parseRowDefinition(row('FW-C-908', { title: 'Another title', acceptance: [] }));
    const c = parseRowDefinition(row('FW-C-908', { verify_probe: 'sh other.sh' }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('fixture rows must parse');
    const h = (d: typeof a.def) => probeHash(probeFromDefinition(d));
    expect(h(a.def)).toBe(h(b.def));
    expect(h(a.def)).not.toBe(h(c.def));
  });

  test('a file name that does not match the id is refused', () => {
    const r = parseRowDefinition(row('FW-C-909'), 'FW-C-910.json');
    expect(r.ok).toBe(false);
  });

  test('sync to an empty database bootstraps the project idempotently', () => {
    const s = fileStore(dir, 'boot.sqlite');
    const d = writeRows(join(dir, 'boot'), [row('FW-C-911')]);
    syncRows(s.writer!, { rowsDir: d, project: PROJECT });
    syncRows(s.writer!, { rowsDir: d, project: PROJECT });
    expect(s.reader().get('SELECT COUNT(*) AS n FROM projects')).toEqual({ n: 1 });
    expect(s.reader().get('SELECT COUNT(*) AS n FROM streams')).toEqual({ n: 1 });
    s.close();
  });
});
