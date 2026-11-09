// Probe c0/premise-retest (WS-P0-020; backlog verify_probe kernel/premise-retest).
// Surface: `fw ledger ready <ID> --json` (Owner marks a row ready; it re-tests the premise by running
// the row's probe first) in a fixture project, and the database.
// Acceptance:
//   - a row whose probe already passes is not claimable: ready is refused and the row is parked as
//     already satisfied (core_adaptation)
//   - the event log records ledger.row_premise_retested with the result for both rows
//   - a row whose probe fails becomes ready (claimable)
import {
  check,
  fixtureRow,
  freshHome,
  fw,
  fwJson,
  openDbReadonly,
  probe,
  projectFromFiles,
  rowFile,
} from './_lib.mjs';

await probe('c0/premise-retest', async () => {
  const proj = projectFromFiles({
    'probes/passes.mjs': 'process.exit(0);\n',
    'probes/fails.mjs': 'process.exit(1);\n',
    ...rowFile(fixtureRow('FW-C-921', { probe: 'node probes/passes.mjs' })),
    ...rowFile(fixtureRow('FW-C-922', { probe: 'node probes/fails.mjs' })),
  });
  const home = freshHome('premise');
  const sync = fw(['ledger', 'sync', '--json'], { home, cwd: proj.work });
  check(sync.status === 0, `fw ledger sync exited ${sync.status}: ${sync.stderr.trim().split('\n')[0]}`);

  const satisfied = fwJson(['ledger', 'ready', 'FW-C-921'], { home, cwd: proj.work });
  check(satisfied.status !== 0, 'a row whose probe already passes was made ready');
  const workable = fwJson(['ledger', 'ready', 'FW-C-922'], { home, cwd: proj.work });
  check(workable.status === 0, `a row whose probe fails was refused (exit ${workable.status})`);

  const s1 = fwJson(['ledger', 'show', 'FW-C-921'], { home, cwd: proj.work });
  const s2 = fwJson(['ledger', 'show', 'FW-C-922'], { home, cwd: proj.work });
  check(/"status":"parked"/.test(JSON.stringify(s1.json)), 'the already-satisfied row is not parked');
  check(/already_satisfied|already satisfied/i.test(JSON.stringify(s1.json)), 'the parked row does not say already satisfied');
  check(/"status":"ready"/.test(JSON.stringify(s2.json)), 'the row with a failing probe is not ready');

  const db = await openDbReadonly(home);
  const ev = db.prepare("SELECT payload FROM events WHERE type = 'ledger.row_premise_retested'").all();
  db.close();
  check(ev.length >= 2, `${ev.length} ledger.row_premise_retested events, want one per re-test (2)`);
  check(ev.some((e) => /pass/.test(e.payload)), 'no premise event records a passing probe');
  check(ev.some((e) => /fail/.test(e.payload)), 'no premise event records a failing probe');
});
