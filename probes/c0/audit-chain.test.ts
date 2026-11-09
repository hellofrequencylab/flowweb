// Probe c0/audit-chain (WS-P0-023; backlog verify_probe security/audit-chain).
// Surface: `fw audit verify --json`, `fw audit head --json`, and openStore to append events.
// Acceptance:
//   - flipping one byte in a stored payload makes verify fail naming the sequence number
//   - verify of 100k events completes in under 5 s (wall clock of the fw command)
//   - the chain head can be exported for external anchoring (fw audit head prints seq and hash,
//     equal to the last event)
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { dbPath, freshHome, fw, fwJson, recomputeChain, requireExport } from './_lib.mjs';

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
    const path = dbPath(home);
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
    const head = fwJson(['audit', 'head'], { home });
    expect(head.status).toBe(0);
    const headText = JSON.stringify(head.json);
    expect(headText, 'head names the last hash').toContain(last.hash);
    expect(headText, 'head names the last seq').toMatch(new RegExp(`\\b${last.seq}\\b`));

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
