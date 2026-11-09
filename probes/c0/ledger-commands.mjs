// Probe c0/ledger-commands (WS-P0-021; backlog verify_probe cli/ledger-commands).
// Surface: fw ledger list|show|next|close with --json, in a fixture project. Rows are made ready
// with `fw ledger ready <ID>` (premise re-test, see c0/premise-retest).
// Acceptance:
//   - fw ledger next prints one row whose dependencies are done (FW-C-932 depends on FW-C-931,
//     which is not done, so next must name FW-C-931)
//   - fw ledger close refuses when the probe fails (exit nonzero, row not done, trigger or probe
//     message surfaced)
//   - all commands support --json (list, list --lane, show, next, close)
import { check, fixtureRow, freshHome, fw, fwJson, probe, projectFromFiles, rowFile } from './_lib.mjs';

await probe('c0/ledger-commands', async () => {
  const proj = projectFromFiles({
    'probes/fails.mjs': 'process.exit(1);\n',
    ...rowFile(fixtureRow('FW-C-931', { probe: 'node probes/fails.mjs', lane: 'kernel' })),
    ...rowFile(fixtureRow('FW-C-932', { probe: 'node probes/fails.mjs', lane: 'kernel', depends_on: ['FW-C-931'] })),
    ...rowFile(fixtureRow('FW-C-933', { probe: 'node probes/fails.mjs', lane: 'cli' })),
  });
  const home = freshHome('lcmd');
  const o = { home, cwd: proj.work };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture');
  check(fw(['ledger', 'ready', 'FW-C-931', '--json'], o).status === 0, 'fw ledger ready FW-C-931 failed');

  const list = fwJson(['ledger', 'list'], o);
  check(list.status === 0, `fw ledger list exited ${list.status}`);
  for (const id of ['FW-C-931', 'FW-C-932', 'FW-C-933']) check(JSON.stringify(list.json).includes(id), `list misses ${id}`);
  const lane = fwJson(['ledger', 'list', '--lane', 'cli'], o);
  check(lane.status === 0, `fw ledger list --lane cli exited ${lane.status}`);
  const laneText = JSON.stringify(lane.json);
  check(laneText.includes('FW-C-933') && !laneText.includes('FW-C-931'), 'list --lane does not filter by lane');

  const next = fwJson(['ledger', 'next'], o);
  check(next.status === 0, `fw ledger next exited ${next.status}`);
  const nextText = JSON.stringify(next.json);
  const named = ['FW-C-931', 'FW-C-932', 'FW-C-933'].filter((id) => nextText.includes(id));
  check(named.length === 1, `fw ledger next should print exactly one row, printed ${named.join(', ') || 'none'}`);
  check(named[0] === 'FW-C-931', `fw ledger next printed ${named[0]}, whose dependencies are not done or which is not ready`);

  const close = fw(['ledger', 'close', 'FW-C-931', '--json'], o);
  check(close.status !== 0, 'fw ledger close succeeded on a row whose probe fails');
  try {
    JSON.parse(close.stdout);
  } catch {
    check(false, 'fw ledger close --json did not print one JSON document on refusal');
  }
  check(/probe|ledger_rows:/i.test(close.stdout + close.stderr), 'the close refusal does not say why (probe or trigger message)');
  const show = fwJson(['ledger', 'show', 'FW-C-931'], o);
  check(!/"status":"done"/.test(JSON.stringify(show.json)), 'the row is done after a refused close');
});
