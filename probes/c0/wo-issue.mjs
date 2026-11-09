// Probe c0/wo-issue (WS-P0-040; backlog verify_probe kernel/work-order-compile; KICKOFF c0/wo-issue).
// Surface: `fw wo issue <ID> [--dry-run] [--doer <agent>] [--verifier <agent>] --json` in a fixture
// project after `fw ledger sync` and `fw ledger ready`. --dry-run compiles without writing.
// Acceptance (WS-P0-040):
//   - output validates against work-order.json (checked with fixtures/validate-json.py)
//   - a row without files_hint compiles with a restrictive default scope (no catch-all touches)
//   - compile is deterministic for the same inputs (same content_hash twice)
//   - scope.touches comes from files_hint, acceptance from the row probe, budget caps from size
// Acceptance (KICKOFF Prompt 3):
//   - self-verify is refused (same agent as doer and verifier)
//   - an unready row is refused
//   - an XL row is refused (exit 3, refused by policy)
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  fixtureRow,
  freshHome,
  fw,
  fwJson,
  missing,
  probe,
  projectFromFiles,
  root,
  rowFile,
  tmpDir,
} from './_lib.mjs';

function workOrderOf(json) {
  return json?.work_order ?? json;
}

await probe('c0/wo-issue', async () => {
  const noHint = fixtureRow('FW-C-943', { probe: 'node probes/fails.mjs' });
  delete noHint.files_hint;
  const proj = projectFromFiles({
    'probes/fails.mjs': 'process.exit(1);\n',
    ...rowFile(fixtureRow('FW-C-941', { probe: 'node probes/fails.mjs' })),
    ...rowFile(fixtureRow('FW-C-942', { probe: 'node probes/fails.mjs', size: 'XL' })),
    ...rowFile(noHint),
    ...rowFile(fixtureRow('FW-C-944', { probe: 'node probes/fails.mjs' })),
  });
  const home = freshHome('wo');
  const o = { home, cwd: proj.work };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture');
  for (const id of ['FW-C-941', 'FW-C-942', 'FW-C-943']) {
    check(fw(['ledger', 'ready', id, '--json'], o).status === 0, `fw ledger ready ${id} failed`);
  }

  const a = fwJson(['wo', 'issue', 'FW-C-941', '--dry-run'], o);
  check(a.status === 0, `fw wo issue FW-C-941 --dry-run exited ${a.status}: ${a.stderr.trim().split('\n')[0]}`);
  const b = fwJson(['wo', 'issue', 'FW-C-941', '--dry-run'], o);
  const wa = workOrderOf(a.json);
  const wb = workOrderOf(b.json);
  check(wa.content_hash && wa.content_hash === wb.content_hash, 'two compiles of the same row differ (content_hash)');

  const tmp = join(tmpDir('wo-json'), 'wo.json');
  writeFileSync(tmp, JSON.stringify(wa));
  const v = spawnSync('python3', ['-I', join(root, 'probes/c0/fixtures/validate-json.py'), 'work-order.json', tmp], {
    encoding: 'utf8',
  });
  if (v.status === 3) missing(v.stderr.trim());
  check(v.status === 0, `work order does not validate against work-order.json: ${v.stderr.trim().split('\n')[0]}`);
  check(wa.scope?.touches?.includes('src/feature.txt'), 'scope.touches is not derived from files_hint');
  check(
    JSON.stringify(wa.acceptance ?? []).includes('node probes/fails.mjs'),
    'acceptance does not carry the row probe command',
  );
  check(wa.budget?.caps && Object.keys(wa.budget.caps).length > 0, 'budget caps are missing');

  const nh = fwJson(['wo', 'issue', 'FW-C-943', '--dry-run'], o);
  check(nh.status === 0, `a row without files_hint does not compile (exit ${nh.status})`);
  const touches = workOrderOf(nh.json).scope?.touches ?? [];
  const catchAll = touches.filter((t) => ['**', '*', '**/*', '.', './', '/'].includes(t));
  check(catchAll.length === 0, `a row without files_hint got a catch-all scope: ${JSON.stringify(touches)}`);

  const self = fw(['wo', 'issue', 'FW-C-941', '--doer', 'agt_probe001', '--verifier', 'agt_probe001', '--json'], o);
  check(self.status !== 0, 'a work order with the same doer and verifier was issued (self-verify)');

  const unready = fw(['wo', 'issue', 'FW-C-944', '--json'], o);
  check(unready.status !== 0, 'a work order was issued for a row that is not ready');

  const xl = fw(['wo', 'issue', 'FW-C-942', '--json'], o);
  check(xl.status === 3, `fw wo issue on an XL row exited ${xl.status}, want 3 (refused by policy)`);

  const real = fwJson(['wo', 'issue', 'FW-C-941'], o);
  check(real.status === 0, `fw wo issue FW-C-941 exited ${real.status}`);
});
