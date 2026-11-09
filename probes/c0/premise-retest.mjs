// Probe c0/premise-retest (WS-P0-020; backlog verify_probe kernel/premise-retest).
// Surface: `fw ledger retest <ID> --json` (runs the row's probe now and moves the row; decision 21),
// then `fw ledger show`, `fw ledger next`, `fw wo issue`, `fw run start` and the database, in a
// fixture project.
// Acceptance:
//   - a row whose probe already passes is not claimable: the re-test parks it as already satisfied
//     (core_adaptation), and next, wo issue and run start all refuse it
//   - the event log records ledger.row_premise_retested with the result for both rows
//   - a row whose probe fails becomes ready (claimable: fw ledger next names it)
import {
  check,
  count,
  fixtureRow,
  fw,
  fwJson,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  projectFromFiles,
  rowFile,
  rowStatusOf,
} from './_lib.mjs';

await probe('c0/premise-retest', async () => {
  const proj = projectFromFiles({
    'probes/passes.mjs': 'process.exit(0);\n',
    'probes/fails.mjs': 'process.exit(1);\n',
    ...rowFile(fixtureRow('FW-C-921', { probe: 'node probes/passes.mjs' })),
    ...rowFile(fixtureRow('FW-C-922', { probe: 'node probes/fails.mjs' })),
  });
  const home = pipelineHome('premise');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  const sync = fw(['ledger', 'sync', '--json'], o);
  check(sync.status === 0, `fw ledger sync exited ${sync.status}: ${sync.stdout.slice(0, 200)}`);

  const satisfied = fwJson(['ledger', 'retest', 'FW-C-921'], o);
  check(satisfied.json?.outcome === 'parked', `re-test of a row whose probe passes gave ${JSON.stringify(satisfied.json).slice(0, 200)}, want outcome parked`);
  check(satisfied.json?.still_valid === false, 'the re-test of a passing probe does not say the premise is gone (still_valid false)');
  const workable = fwJson(['ledger', 'retest', 'FW-C-922'], o);
  check(workable.status === 0, `re-test of a row whose probe fails exited ${workable.status}`);
  check(workable.json?.outcome === 'ready', `re-test of a row whose probe fails gave outcome ${workable.json?.outcome}, want ready`);

  const s1 = fwJson(['ledger', 'show', 'FW-C-921'], o);
  const s2 = fwJson(['ledger', 'show', 'FW-C-922'], o);
  check(/"status":"parked"/.test(JSON.stringify(s1.json)), 'the already-satisfied row is not parked');
  check(/already_satisfied/.test(JSON.stringify(s1.json)), 'fw ledger show of the parked row does not say already_satisfied');
  check(/"status":"ready"/.test(JSON.stringify(s2.json)), 'the row with a failing probe is not ready');

  // Not claimable: next names only the ready row; work orders and runs refuse the parked one.
  const next = fwJson(['ledger', 'next'], o);
  const nextText = JSON.stringify(next.json);
  check(nextText.includes('FW-C-922') && !nextText.includes('FW-C-921'), `fw ledger next printed ${nextText.slice(0, 200)}`);
  const wo = fw(['wo', 'issue', 'FW-C-921', '--json'], o);
  check(wo.status !== 0, 'a work order was issued for an already-satisfied row');
  const run = fw(['run', 'start', 'FW-C-921', '--adapter', 'fake', '--json'], o);
  check(run.status !== 0, 'fw run start ran an already-satisfied row');

  const db = await openDbReadonly(home);
  check(rowStatusOf(db, 'FW-C-921') === 'parked', `FW-C-921 is ${rowStatusOf(db, 'FW-C-921')} after the refusals, want parked`);
  check(count(db, 'SELECT count(*) FROM runs') === 0, 'a run was created for the parked row');
  const ev = db.prepare("SELECT payload FROM events WHERE type = 'ledger.row_premise_retested'").all().map((e) => JSON.parse(e.payload));
  db.close();
  check(ev.length === 2, `${ev.length} ledger.row_premise_retested events, want one per re-test (2)`);
  const by = Object.fromEntries(ev.map((p) => [p.code, p]));
  check(by['FW-C-921']?.result === 'already_satisfied', `premise event for FW-C-921 records ${by['FW-C-921']?.result}, want already_satisfied`);
  check(by['FW-C-922']?.result === 'probe_fails', `premise event for FW-C-922 records ${by['FW-C-922']?.result}, want probe_fails`);
});
