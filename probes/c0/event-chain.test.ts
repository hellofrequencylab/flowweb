// Probe c0/event-chain (FW-C-004; backlog verify_probe kernel/event-writer).
// Surface: openStore from packages/eventlog/src/index.ts (Store port in types.ts) and the database
// file. The chain is re-computed independently with the reference formula of
// tests/schema_core_test.py: hash = sha256(prev_hash + "\n" + canonical(envelope without hash)).
// KICKOFF Prompt 2 acceptance:
//   - 1,000 appended events verify; flipping one byte in a payload makes verifyChain return that seq;
//     deleting a row is refused by the gapless trigger
//   - a second writer process fails fast with a typed error while the first holds the lock
// FW-C-004 acceptance:
//   - appending the same (type, idempotency_key) twice returns the original event and writes nothing
//   - a payload with an API-key-shaped string is redacted before write and the redaction is recorded
//   - two processes racing to write: the second gets a typed LOCKED error; no event lost or duplicated
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { dbPath, fakeSecret, freshHome, recomputeChain, requireExport, root, TSX } from './_lib.mjs';

type Ev = { seq: number; id: string; idempotency_key: string; payload: Record<string, unknown> };
type Writer = { appendEvent: (e: Record<string, unknown>) => Ev };
type Store = {
  writer: Writer | undefined;
  verifyChain: () => { ok: boolean; seq?: number; count: number };
  close: () => void;
};
type OpenStore = (o: { path: string; readonly?: boolean }) => Store | Promise<Store>;

const ev = (i: number, extra: Record<string, unknown> = {}) => ({
  type: 'system.config_changed',
  actor_kind: 'system',
  actor_id: 'probe',
  idempotency_key: `probe-${i}`,
  payload: { i, note: `marker-${String(i).padStart(4, '0')}` },
  ...extra,
});

function allEvents(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare('SELECT * FROM events ORDER BY seq').all();
  db.close();
  return rows as Record<string, string>[];
}

describe('c0/event-chain', () => {
  test('1,000 events verify (store and independent recompute); a flipped payload byte is found by seq', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-004')) as OpenStore;
    const path = dbPath(freshHome('chain'));
    const store = await openStore({ path });
    const appended: Ev[] = [];
    for (let i = 1; i <= 1000; i++) appended.push(store.writer!.appendEvent(ev(i)));
    const v = store.verifyChain();
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.count).toBeGreaterThanOrEqual(1000);
    store.close();
    const indep = recomputeChain(allEvents(path));
    expect(indep, 'independent recompute with the reference formula').toMatchObject({ ok: true });

    const target = appended[499]!;
    const db = new DatabaseSync(path);
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events'").all()) {
      db.exec(`DROP TRIGGER "${t.name}"`);
    }
    const row = db.prepare('SELECT payload FROM events WHERE seq = ?').get(target.seq) as { payload: string };
    db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(row.payload.replace('marker-0500', 'marker-0501'), target.seq);
    db.close();
    const ro = await openStore({ path, readonly: true });
    const broken = ro.verifyChain();
    ro.close();
    expect(broken.ok, 'verifyChain detects the flipped byte').toBe(false);
    expect(broken.seq, 'verifyChain names the tampered seq').toBe(target.seq);
  });

  test('update and delete of an event are refused by the database', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-004')) as OpenStore;
    const path = dbPath(freshHome('chain-del'));
    const store = await openStore({ path });
    for (let i = 1; i <= 10; i++) store.writer!.appendEvent(ev(i));
    store.close();
    const db = new DatabaseSync(path);
    expect(() => db.prepare('DELETE FROM events WHERE seq = (SELECT max(seq) - 3 FROM events)').run()).toThrow();
    expect(() => db.prepare("UPDATE events SET payload = '{}' WHERE seq = 1").run()).toThrow();
    db.close();
  });

  test('same (type, idempotency_key) twice returns the original and writes nothing', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-004')) as OpenStore;
    const path = dbPath(freshHome('chain-idem'));
    const store = await openStore({ path });
    const a = store.writer!.appendEvent(ev(1));
    const before = allEvents(path).length;
    const b = store.writer!.appendEvent({ ...ev(1), payload: { different: true } });
    expect(b.id, 'duplicate returns the original event').toBe(a.id);
    expect(b.seq).toBe(a.seq);
    expect(allEvents(path).length, 'nothing written').toBe(before);
    store.close();
  });

  test('an API-key-shaped string is redacted before write and the redaction is recorded', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-004')) as OpenStore;
    const path = dbPath(freshHome('chain-redact'));
    const store = await openStore({ path });
    const secret = fakeSecret('anthropic');
    store.writer!.appendEvent(ev(1, { payload: { note: `vendor said ${secret}` } }));
    store.close();
    for (const f of [path, `${path}-wal`]) {
      let bytes = Buffer.alloc(0);
      try {
        bytes = readFileSync(f);
      } catch {}
      expect(bytes.includes(Buffer.from(secret)), `${f} must not contain the secret`).toBe(false);
    }
    const rows = allEvents(path);
    expect(
      rows.some((r) => /redact/i.test(r.payload) || /redact/i.test(r.type)),
      'some stored event records that a redaction happened',
    ).toBe(true);
    expect(recomputeChain(rows)).toMatchObject({ ok: true });
  });

  test('a second writer process fails fast with a typed lock error; no event lost or duplicated', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'FW-C-004')) as OpenStore;
    const home = freshHome('chain-lock');
    const path = dbPath(home);
    const script = join(home, 'holder.ts');
    writeFileSync(
      script,
      `import { openStore } from ${JSON.stringify(join(root, 'packages/eventlog/src/index.ts'))};
const s = await openStore({ path: ${JSON.stringify(path)} });
for (let i = 1; i <= 50; i++) s.writer!.appendEvent({ type: 'system.config_changed', actor_kind: 'system', actor_id: 'holder', idempotency_key: 'h-' + i, payload: { i } });
console.log('READY');
setTimeout(() => { s.close(); process.exit(0); }, 3000);
`,
    );
    const child = spawn(TSX, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((r) => child.on('exit', r));
    const until = Date.now() + 30000;
    while (!out.includes('READY')) {
      if (Date.now() > until || child.exitCode !== null) throw new Error(`holder process did not get the writer: ${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const started = Date.now();
    let err: unknown;
    try {
      const s = await openStore({ path });
      void s.writer; // the writer getter throws WriterLockError when another process holds the lock
      s.writer!.appendEvent(ev(9999));
      s.close();
    } catch (e) {
      err = e;
    }
    expect(Date.now() - started, 'fails fast, not a hang').toBeLessThan(2000);
    expect(err, 'the second writer must be refused').toBeTruthy();
    const e = err as { name?: string; code?: string };
    expect(e.name === 'WriterLockError' || e.code === 'LOCKED', `typed lock error, got ${e.name}/${e.code}`).toBe(true);
    await exited;
    const rows = allEvents(path);
    expect(rows.filter((r) => r.actor_id === 'holder').length, 'no holder event lost or duplicated').toBe(50);
    expect(rows.some((r) => r.idempotency_key === 'probe-9999'), 'the refused writer wrote nothing').toBe(false);
    expect(recomputeChain(rows)).toMatchObject({ ok: true });
  });
});
