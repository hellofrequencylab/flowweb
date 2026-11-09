// Probe c0/ledger-commands (WS-P0-021; backlog verify_probe cli/ledger-commands).
// Surface: fw ledger list|show|next|retest|close with --json, and fw run start with the fake vendor
// to bring a row to verifying, in a fixture project with a local bare remote.
// Acceptance:
//   - fw ledger next prints one row whose dependencies are done: FW-C-931 and FW-C-933 are ready
//     with no dependencies, FW-C-932 depends on FW-C-931 (not done), so next prints exactly one row
//     and never FW-C-932
//   - fw ledger close refuses when the probe fails: FW-C-931 is in verifying (a fake run opened its
//     PR), main does not contain the change, and `close --merged-sha <main head>` runs the probe on
//     main, where it fails; the refusal says why and the row stays verifying
//   - all commands support --json (list, list --lane, show, next, retest, close; each prints one
//     JSON document)
import {
  check,
  fixtureRow,
  fw,
  fwJson,
  git,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  projectFromFiles,
  rowFile,
  rowStatusOf,
  CHECK_FEATURE,
} from './_lib.mjs';

await probe('c0/ledger-commands', async () => {
  const proj = projectFromFiles({
    'check-feature.mjs': CHECK_FEATURE,
    ...rowFile(fixtureRow('FW-C-931', { lane: 'kernel' })),
    ...rowFile(fixtureRow('FW-C-932', { lane: 'kernel', depends_on: ['FW-C-931'] })),
    ...rowFile(fixtureRow('FW-C-933', { lane: 'cli' })),
  });
  const home = pipelineHome('lcmd');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture');
  for (const id of ['FW-C-931', 'FW-C-932', 'FW-C-933']) {
    const r = fwJson(['ledger', 'retest', id], o);
    check(r.status === 0, `fw ledger retest ${id} --json exited ${r.status}`);
  }

  const list = fwJson(['ledger', 'list'], o);
  check(list.status === 0, `fw ledger list exited ${list.status}`);
  for (const id of ['FW-C-931', 'FW-C-932', 'FW-C-933']) check(JSON.stringify(list.json).includes(id), `list misses ${id}`);
  const lane = fwJson(['ledger', 'list', '--lane', 'cli'], o);
  check(lane.status === 0, `fw ledger list --lane cli exited ${lane.status}`);
  const laneText = JSON.stringify(lane.json);
  check(laneText.includes('FW-C-933') && !laneText.includes('FW-C-931'), 'list --lane does not filter by lane');
  const show = fwJson(['ledger', 'show', 'FW-C-932'], o);
  check(show.status === 0 && JSON.stringify(show.json).includes('FW-C-932'), 'fw ledger show FW-C-932 --json failed');

  const next = fwJson(['ledger', 'next'], o);
  check(next.status === 0, `fw ledger next exited ${next.status}`);
  const nextText = JSON.stringify(next.json);
  const named = ['FW-C-931', 'FW-C-932', 'FW-C-933'].filter((id) => nextText.includes(id));
  check(named.length === 1, `fw ledger next should print exactly one row, printed ${named.join(', ') || 'none'}`);
  check(named[0] !== 'FW-C-932', 'fw ledger next printed FW-C-932, whose dependency FW-C-931 is not done');

  const run = fwJson(['run', 'start', 'FW-C-931', '--adapter', 'fake'], o);
  check(run.status === 0, `fw run start FW-C-931 exited ${run.status}: ${run.stdout.slice(0, 300)}`);
  let db = await openDbReadonly(home);
  check(rowStatusOf(db, 'FW-C-931') === 'verifying', `FW-C-931 is ${rowStatusOf(db, 'FW-C-931')} after the run, want verifying`);
  db.close();

  const mainHead = git(proj.work, 'rev-parse', 'HEAD');
  const close = fw(['ledger', 'close', 'FW-C-931', '--merged-sha', mainHead, '--json'], o);
  check(close.status !== 0, 'fw ledger close succeeded on a commit where the row probe fails');
  let doc;
  try {
    doc = JSON.parse(close.stdout);
  } catch {
    check(false, 'fw ledger close --json did not print one JSON document on refusal');
  }
  check(/probe|ledger_rows/i.test(JSON.stringify(doc)), `the close refusal does not say why: ${close.stdout.slice(0, 200)}`);
  db = await openDbReadonly(home);
  check(rowStatusOf(db, 'FW-C-931') === 'verifying', `the row is ${rowStatusOf(db, 'FW-C-931')} after a refused close, want verifying`);
  const probeRun = db
    .prepare("SELECT payload FROM events WHERE type = 'ledger.probe_executed' ORDER BY seq DESC LIMIT 1")
    .get();
  db.close();
  const p = JSON.parse(probeRun?.payload ?? '{}');
  check(p.status === 'fail' && p.target_sha === mainHead, 'the refused close did not record a failing probe run on the given commit');
});
