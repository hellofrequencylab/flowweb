// Probe c0/audit-chain (WS-P0-023; backlog verify_probe security/audit-chain).
// probe-timeout-s: 240 (14 s on Linux, 34 s on macOS alone and over 60 s under load)
// Surface: `fw audit verify --json` ({ ok, count, head } on a clean chain, { ok: false, seq, reason }
// on a break) and openStore to append events.
// Acceptance:
//   - flipping one byte in a stored payload makes verify fail naming the sequence number
//   - verify of 100k events completes in under 5 s (wall clock of the fw command)
//   - the chain head can be exported for external anchoring: `fw audit verify --json` prints the
//     head hash and the event count, equal to the hash and seq of the last event (the chain is
//     gapless, so count is the head seq). The draft assumed a separate `fw audit head`; the code
//     exports the head from verify instead, which meets the line.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { freshHome, fw, fwJson, recomputeChain, requireExport, storePath } from './_lib.mjs';

type Writer = {
  appendEvent: (e: Record<string, unknown>) => { seq: number };
  transaction: <T>(fn: (w: Writer) => T) => T;
};
type Store = { writer: Writer | undefined; close: () => void };
type OpenStore = (o: { path: string }) => Store | Promise<Store>;

const N = 100_000;

describe('c0/audit-chain', () => {
  test('fw audit verify: clean, fast on 100k events, head exportable, tamper named by seq', async () => {
    const openStore = (await requireExport('eventlog', 'openStore', 'WS-P0-023')) as OpenStore;
    const home = freshHome('audit');
    const path = storePath(home);
    const store = await openStore({ path });
    const w = store.writer!;
    let target = 0;
    for (let start = 1; start <= N; start += 5000) {
      w.transaction((tx) => {
        for (let i = start; i < start + 5000 && i <= N; i++) {
          const e = tx.appendEvent({
            type: 'system.config_changed',
            actor_kind: 'system',
            actor_id: 'probe',
            idempotency_key: `a-${i}`,
            payload: { i, note: `audit-${String(i).padStart(6, '0')}` },
          });
          if (i === 77_777) target = e.seq;
        }
      });
    }
    store.close();

    const ok = fwJson(['audit', 'verify'], { home, timeoutMs: 60000 });
    expect(ok.status, `fw audit verify on a clean chain: ${ok.stderr}`).toBe(0);
    expect(ok.ms, 'fw audit verify of 100k events (whole command)').toBeLessThan(5000);

    const db = new DatabaseSync(path, { readOnly: true });
    const last = db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string };
    expect(recomputeChain(db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, string>[])).toMatchObject({
      ok: true,
    });
    db.close();
    expect(ok.json.ok, 'verify reports ok').toBe(true);
    expect(ok.json.head, 'the exported head is the hash of the last event').toBe(last.hash);
    expect(ok.json.count, 'the exported count is the seq of the last event').toBe(last.seq);

    const attacker = new DatabaseSync(path);
    for (const t of attacker.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events'").all()) {
      attacker.exec(`DROP TRIGGER "${t.name}"`);
    }
    const row = attacker.prepare('SELECT payload FROM events WHERE seq = ?').get(target) as { payload: string };
    attacker.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(row.payload.replace('audit-077777', 'audit-077778'), target);
    attacker.close();
    const bad = fw(['audit', 'verify', '--json'], { home, timeoutMs: 60000 });
    expect(bad.status, 'verify fails on a tampered chain').not.toBe(0);
    expect(bad.stdout + bad.stderr, 'verify names the broken seq').toMatch(new RegExp(`\\b${target}\\b`));
  }, 300_000);
});
