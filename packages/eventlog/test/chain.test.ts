// FW-C-004 / WS-P0-023 / kickoff "c0/event-chain": append, canonical hash, tamper and gap detection.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@fw/contracts';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  type EventRow,
  envelopeHash,
  envelopeOf,
  GENESIS_HASH,
  openStore,
  payloadHash,
  type StoredEvent,
} from '../src/index.ts';
import { copyDb, ev, REPO_ROOT, seededDb, tempDir, withStore } from './helpers.ts';

const dir = tempDir();

function rowOf(e: StoredEvent): EventRow {
  return { ...e, payload: JSON.stringify(e.payload) };
}

function contractEnvelope(e: StoredEvent): Record<string, unknown> {
  return { ...envelopeOf(rowOf(e), e.payload), hash: e.hash };
}

describe('reference hash', () => {
  test('reproduces payload_hash and hash of contracts-core/examples/20-event-envelope.json', () => {
    const ex = JSON.parse(
      readFileSync(join(REPO_ROOT, 'contracts-core/examples/20-event-envelope.json'), 'utf8'),
    );
    expect(payloadHash(ex.payload)).toBe(ex.payload_hash);
    expect(envelopeHash(ex)).toBe(ex.hash);
    // The same example rebuilt from a stored row (nulls for absent optional columns) hashes the same.
    const row: EventRow = {
      seq: ex.seq,
      id: ex.id,
      ts: ex.ts,
      type: ex.type,
      version: ex.version,
      actor_kind: ex.actor.kind,
      actor_id: ex.actor.id,
      project_id: ex.project_id,
      stream_id: null,
      work_order_id: ex.work_order_id,
      run_id: ex.run_id,
      correlation_id: ex.correlation_id,
      causation_id: ex.causation_id,
      idempotency_key: ex.idempotency_key,
      payload: JSON.stringify(ex.payload),
      payload_hash: ex.payload_hash,
      prev_hash: ex.prev_hash,
      hash: ex.hash,
    };
    expect(envelopeHash(envelopeOf(row, ex.payload))).toBe(ex.hash);
  });
});

describe('append and verify', () => {
  test('1,000 appended events verify, gapless and linked from genesis', () => {
    const store = openStore({ path: join(dir, 'thousand.sqlite') });
    const w = store.writer!;
    const events: StoredEvent[] = [];
    for (let i = 1; i <= 1000; i++) events.push(w.appendEvent(ev(i)));
    expect(events[0]!.prev_hash).toBe(GENESIS_HASH);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      if (i > 0) expect(e.prev_hash).toBe(events[i - 1]!.hash);
    });
    const r = store.verifyChain();
    expect(r).toEqual({ ok: true, count: 1000, head: events[999]!.hash });
    store.close();
  });

  test('stored events are valid event-envelope contracts', () => {
    const store = openStore({ path: ':memory:' });
    const e = store.writer!.appendEvent(
      ev(1, { project_id: 'prj_core1', run_id: 'run_000001', causation_id: 'evt_00000001' }),
    );
    const env = contractEnvelope(e);
    expect(validate('event-envelope', env)).toEqual({ ok: true, errors: [] });
    expect(env).not.toHaveProperty('stream_id');
    store.close();
  });

  test('an empty log verifies with the genesis head', () => {
    const store = openStore({ path: ':memory:' });
    expect(store.verifyChain()).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
    store.close();
  });

  test('the same (type, idempotency_key) twice returns the original and writes nothing', () => {
    const store = openStore({ path: ':memory:' });
    const w = store.writer!;
    const a = w.appendEvent(ev(1, { idempotency_key: 'run_1+started' }));
    const b = w.appendEvent(ev(2, { idempotency_key: 'run_1+started' }));
    expect(b).toEqual(a);
    const c = w.appendEvent(ev(3, { type: 'run.failed', idempotency_key: 'run_1+started' }));
    expect(c.seq).toBe(2);
    expect(w.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n).toBe(2);
    store.close();
  });

  test('a transaction that throws leaves no event; nested transactions join the outer one', () => {
    const store = openStore({ path: ':memory:' });
    const w = store.writer!;
    expect(() =>
      w.transaction((t) => {
        t.appendEvent(ev(1));
        t.transaction((inner) => inner.appendEvent(ev(2)));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.verifyChain()).toMatchObject({ ok: true, count: 0 });
    w.transaction((t) => {
      t.appendEvent(ev(1));
      t.transaction((inner) => inner.appendEvent(ev(2)));
    });
    expect(store.verifyChain()).toMatchObject({ ok: true, count: 2 });
    store.close();
  });

  test('unknown event types are refused by the closed union', () => {
    const store = openStore({ path: ':memory:' });
    expect(() => store.writer!.appendEvent(ev(1, { type: 'made.up' }))).toThrow(/FOREIGN KEY/);
    store.close();
  });
});

describe('tamper detection', () => {
  const base = seededDb(dir, 'base.sqlite', 1000);

  for (const seq of [1, 437, 1000]) {
    test(`flipping one byte of the stored payload of seq ${seq} makes verifyChain return ${seq}`, () => {
      const copy = copyDb(base, join(dir, `tamper-${seq}.sqlite`));
      const raw = new Database(copy);
      // An attacker with raw file access: the append-only trigger has to go first.
      raw.exec('DROP TRIGGER trg_events_no_update');
      const { payload } = raw.prepare('SELECT payload FROM events WHERE seq = ?').get(seq) as {
        payload: string;
      };
      const buf = Buffer.from(payload, 'utf8');
      const at = buf.indexOf('event number');
      buf[at] = buf[at]! ^ 1; // 'e' -> 'd'
      raw.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(buf.toString('utf8'), seq);
      raw.close();
      const r = withStore(copy, (s) => s.verifyChain(), true);
      expect(r).toMatchObject({ ok: false, seq, count: seq - 1 });
    });
  }

  test('changing a stored hash breaks the link at that row', () => {
    const copy = copyDb(base, join(dir, 'tamper-hash.sqlite'));
    const raw = new Database(copy);
    raw.exec('DROP TRIGGER trg_events_no_update');
    raw.prepare("UPDATE events SET hash = replace(hash, substr(hash, 1, 1), 'x') WHERE seq = 10").run();
    raw.close();
    expect(withStore(copy, (s) => s.verifyChain(), true)).toMatchObject({ ok: false, seq: 10 });
  });

  test('UPDATE and DELETE on events are refused by the append-only triggers', () => {
    const copy = copyDb(base, join(dir, 'guarded.sqlite'));
    const raw = new Database(copy);
    expect(() => raw.prepare("UPDATE events SET payload = '{}' WHERE seq = 3").run()).toThrow(
      /append-only: UPDATE forbidden/,
    );
    expect(() => raw.prepare('DELETE FROM events WHERE seq = 3').run()).toThrow(
      /append-only: DELETE forbidden/,
    );
    raw.close();
    withStore(copy, (s) => {
      expect(() => s.writer!.run('DELETE FROM events WHERE seq = 1000')).toThrow(
        /append-only: DELETE forbidden/,
      );
      expect(s.verifyChain()).toMatchObject({ ok: true, count: 1000 });
    });
  });

  test('a row deleted behind the triggers is reported as a gap at the next seq', () => {
    const copy = copyDb(base, join(dir, 'deleted.sqlite'));
    const raw = new Database(copy);
    raw.exec('DROP TRIGGER trg_events_no_delete');
    raw.prepare('DELETE FROM events WHERE seq = 500').run();
    raw.close();
    expect(withStore(copy, (s) => s.verifyChain(), true)).toMatchObject({ ok: false, seq: 501, count: 499 });
  });

  test('an insert that skips a seq is refused by the gapless trigger', () => {
    const copy = copyDb(base, join(dir, 'gap.sqlite'));
    const raw = new Database(copy);
    const head = raw.prepare('SELECT hash FROM events WHERE seq = 1000').get() as { hash: string };
    expect(() =>
      raw
        .prepare(
          'INSERT INTO events(seq,id,ts,type,actor_kind,actor_id,correlation_id,idempotency_key,payload,payload_hash,prev_hash,hash) ' +
            "VALUES (1002,'evt_gap1',?,'system.started','system','fwd','corr_1','gap','{}',?,?,?)",
        )
        .run(new Date().toISOString(), GENESIS_HASH, head.hash, 'f'.repeat(64)),
    ).toThrow(/seq must be max\(seq\)\+1/);
    raw.close();
  });
});

describe('performance', () => {
  test('verifying 100,000 events takes under 5 s', () => {
    const path = seededDb(dir, 'big.sqlite', 100_000);
    withStore(
      path,
      (s) => {
        const t0 = performance.now();
        const r = s.verifyChain();
        const ms = performance.now() - t0;
        expect(r).toMatchObject({ ok: true, count: 100_000 });
        expect(ms).toBeLessThan(5000);
      },
      true,
    );
  }, 120_000);
});
