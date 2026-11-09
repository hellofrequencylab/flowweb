// Probe c0/ledger-fsm (WS-P0-016; backlog verify_probe kernel/ledger-fsm).
// Surface: `fw ledger sync` to load the rows, then `transitionRow(writer, rowKey, to, ctx)` exported
// by packages/ledger/src/index.ts, called with the writer of openStore (Store port).
// Acceptance:
//   - an illegal transition (open -> done) is rejected and changes nothing
//   - every transition emits an event (ledger.row_status_changed naming from and to)
//   - "done -> regressed fires automatically on a failing probe re-run" needs a done row, which only
//     the pipeline can produce; that line is proven by c0/run-fake-e2e (see probes/c0/README.md).
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { dbPath, freshHome, fw, git, requireExport, root, tmpDir } from './_lib.mjs';

type Writer = unknown;
type Store = { writer: Writer | undefined; close: () => void };
type OpenStore = (o: { path: string }) => Store | Promise<Store>;
type TransitionRow = (w: Writer, rowKey: string, to: string, ctx?: Record<string, unknown>) => unknown;

describe('c0/ledger-fsm', () => {
  test('illegal transitions are refused; legal ones emit an event', async () => {
    const transitionRow = (await requireExport('ledger', 'transitionRow', 'WS-P0-016')) as TransitionRow;
    const openStore = (await requireExport('eventlog', 'openStore', 'WS-P0-016')) as OpenStore;
    const home = freshHome('fsm');
    const proj = tmpDir('fsm-proj');
    cpSync(join(root, 'ledger/rows'), join(proj, 'ledger/rows'), { recursive: true });
    git(proj, 'init', '-q', '-b', 'main');
    git(proj, 'add', '.');
    git(proj, 'commit', '-qm', 'rows');
    const sync = fw(['ledger', 'sync', '--json'], { home, cwd: proj });
    expect(sync.status, `fw ledger sync: ${sync.stderr}`).toBe(0);

    const read = () => {
      const db = new DatabaseSync(dbPath(home), { readOnly: true });
      const rows = db.prepare('SELECT id, status FROM ledger_rows ORDER BY id').all();
      const events = db.prepare("SELECT payload FROM events WHERE type = 'ledger.row_status_changed'").all();
      db.close();
      return { rows: JSON.stringify(rows), events: events.map((e) => String(e.payload)) };
    };

    const store = await openStore({ path: dbPath(home) });
    try {
      const before = read();
      expect(() => transitionRow(store.writer, 'FW-C-005', 'done', { reason: 'probe' }), 'open -> done').toThrow();
      expect(() => transitionRow(store.writer, 'FW-C-005', 'merging', { reason: 'probe' }), 'open -> merging').toThrow();
      const afterIllegal = read();
      expect(afterIllegal.rows, 'a refused transition changes no row').toBe(before.rows);
      expect(afterIllegal.events.length, 'a refused transition emits no status event').toBe(before.events.length);

      transitionRow(store.writer, 'FW-C-005', 'blocked', { reason: 'probe: blocker recorded' });
      transitionRow(store.writer, 'FW-C-006', 'parked', { reason: 'probe: parked by Owner' });
      const after = read();
      expect(after.events.length, 'two legal transitions emit two status events').toBe(before.events.length + 2);
      const last = after.events.slice(-2).join('\n');
      expect(last).toMatch(/blocked/);
      expect(last).toMatch(/parked/);
      expect(last).toMatch(/open/);
    } finally {
      store.close();
    }
  });
});
