// Probe c0/ledger-sync (FW-C-005; backlog verify_probe kernel/ledger-sync).
// Surface: `fw ledger sync --json` and `fw ledger show <ID> --json`, run inside a scratch git repo
// that holds a copy of ledger/rows/, with a fresh FW_HOME; the database is read with node:sqlite.
// Acceptance (FW-C-005 and KICKOFF Prompt 3):
//   - every row file of ledger/rows/ (the 67 backlog rows) imports into ledger_rows with status open and one ledger.row_created event each
//   - the second sync is idempotent (no new rows, no new ledger.row_created events, rows unchanged)
//   - editing the probe of an already-synced row file is refused (exit 1, the row id named), leaves
//     ledger_rows untouched, and is recorded as a tamper event
//   - status is never read from or written to row files: a row file carrying "status": "done" is not
//     imported as done, and sync never modifies a row file
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  count,
  freshHome,
  fw,
  fwJson,
  git,
  openDbReadonly,
  probe,
  root,
  tmpDir,
  treeHash,
} from './_lib.mjs';

const ROWS = readdirSync(join(root, 'ledger/rows')).filter((n) => n.endsWith('.json')).length;

function snapshot(db) {
  return JSON.stringify(db.prepare('SELECT * FROM ledger_rows ORDER BY id').all());
}

await probe('c0/ledger-sync', async () => {
  const home = freshHome('sync');
  const proj = tmpDir('sync-proj');
  cpSync(join(root, 'ledger/rows'), join(proj, 'ledger/rows'), { recursive: true });
  git(proj, 'init', '-q', '-b', 'main');
  git(proj, 'add', '.');
  git(proj, 'commit', '-qm', 'rows');
  const rowsBefore = treeHash(join(proj, 'ledger/rows'));

  const first = fwJson(['ledger', 'sync'], { home, cwd: proj });
  check(first.status === 0, `fw ledger sync exited ${first.status}: ${first.stderr.trim().split('\n')[0]}`);
  let db = await openDbReadonly(home);
  check(count(db, 'SELECT count(*) FROM ledger_rows') === ROWS, `ledger_rows has ${count(db, 'SELECT count(*) FROM ledger_rows')} rows, want ${ROWS}`);
  check(count(db, "SELECT count(*) FROM ledger_rows WHERE status <> 'open'") === 0, 'a freshly synced row is not open');
  const created = count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_created'");
  check(created === ROWS, `${created} ledger.row_created events, want ${ROWS}`);
  const snap1 = snapshot(db);
  db.close();

  const show = fwJson(['ledger', 'show', 'FW-C-005'], { home, cwd: proj });
  check(show.status === 0, `fw ledger show FW-C-005 exited ${show.status}`);
  check(JSON.stringify(show.json).includes('FW-C-005'), 'fw ledger show FW-C-005 --json does not name the row');
  check(/"status":"open"/.test(JSON.stringify(show.json)), 'fw ledger show FW-C-005 --json does not report status open');

  const second = fwJson(['ledger', 'sync'], { home, cwd: proj });
  check(second.status === 0, `second fw ledger sync exited ${second.status}`);
  db = await openDbReadonly(home);
  check(snapshot(db) === snap1, 'second sync changed ledger_rows (not idempotent)');
  check(count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_created'") === ROWS, 'second sync emitted ledger.row_created again');
  const eventsBeforeTamper = count(db, 'SELECT count(*) FROM events');
  db.close();

  const f = join(proj, 'ledger/rows/FW-C-006.json');
  const row = JSON.parse(readFileSync(f, 'utf8'));
  row.verify_probe = 'pnpm probe cli/something-easier';
  writeFileSync(f, `${JSON.stringify(row, null, 2)}\n`);
  const tamper = fw(['ledger', 'sync', '--json'], { home, cwd: proj });
  check(tamper.status === 1, `sync with an edited probe exited ${tamper.status}, want 1`);
  check(/FW-C-006/.test(tamper.stdout + tamper.stderr), 'the refusal does not name FW-C-006');
  db = await openDbReadonly(home);
  check(snapshot(db) === snap1, 'a refused probe change still modified ledger_rows');
  const tamperEvents = db
    .prepare('SELECT type, payload FROM events WHERE seq > ?')
    .all(eventsBeforeTamper)
    .filter((e) => /tamper/i.test(e.type) || /tamper/i.test(e.payload));
  db.close();
  check(treeHash(join(proj, 'ledger/rows')) !== rowsBefore, 'sanity: the fixture edit happened');

  // Restore the row, add a new row file that claims status done.
  git(proj, 'checkout', '--', 'ledger/rows/FW-C-006.json');
  const fresh = JSON.parse(readFileSync(join(proj, 'ledger/rows/FW-C-001.json'), 'utf8'));
  fresh.id = 'FW-C-950';
  fresh.title = 'Probe fixture row that claims a status';
  fresh.depends_on = [];
  fresh.status = 'done';
  writeFileSync(join(proj, 'ledger/rows/FW-C-950.json'), `${JSON.stringify(fresh, null, 2)}\n`);
  const withStatus = treeHash(join(proj, 'ledger/rows'));
  const st = fw(['ledger', 'sync', '--json'], { home, cwd: proj });
  db = await openDbReadonly(home);
  const rows = db.prepare("SELECT status FROM ledger_rows WHERE status = 'done'").all();
  check(rows.length === 0, 'a status field in a row file was imported (a row is done after sync)');
  db.close();
  check(st.status === 0 || st.status === 1, `sync with a status field exited ${st.status}`);
  check(treeHash(join(proj, 'ledger/rows')) === withStatus, 'fw ledger sync modified a row file');

  // Checked last so every other line is proven first. FW-C-005 asks for a tamper event; the code
  // refuses and writes nothing (decision 19). audit.finding_raised (what a tampered probe run
  // records) would satisfy this line without a schema change.
  check(tamperEvents.length >= 1, 'no tamper event was recorded for the refused probe change (FW-C-005 line 2)');
});
