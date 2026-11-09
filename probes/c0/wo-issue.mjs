// Probe c0/wo-issue (WS-P0-040; backlog verify_probe kernel/work-order-compile; KICKOFF c0/wo-issue).
// Surfaces: `fw wo issue <ID> [--doer <agent>] [--verifier <agent>] --json` (prints the issue report
// with the compiled work_order) in a fixture project after `fw ledger sync` and `fw ledger retest`;
// compileWorkOrder and loadCorePolicy from packages/ledger/src/index.ts (determinism); the database.
// Acceptance (WS-P0-040):
//   - output validates against work-order.json (fixtures/validate-json.py, the contracts-core stack)
//   - a row without files_hint compiles with a restrictive default scope (no catch-all touches)
//   - compile is deterministic for the same inputs: recompiling the issued order from the same
//     inputs (row, probe, row file, base commit, policy, roles, id, version, issue time) gives the
//     same content_hash, which is also the hash stored on work_orders
//   - scope.touches comes from files_hint, acceptance from the row file, caps from the size table
// Acceptance (KICKOFF Prompt 3):
//   - self-verify is refused (same agent as doer and verifier)
//   - an unready row is refused
//   - an XL row is refused (exit 3, refused by policy; open: decision 22, refusals exit 1)
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_FEATURE,
  check,
  dbPath,
  fixtureRow,
  fw,
  fwJson,
  missing,
  openDbReadonly,
  pipelineHome,
  probe,
  projectFromFiles,
  root,
  rowFile,
  TSX,
  tmpDir,
} from './_lib.mjs';

await probe('c0/wo-issue', async () => {
  const noHint = fixtureRow('FW-C-943');
  delete noHint.files_hint;
  const proj = projectFromFiles({
    'check-feature.mjs': CHECK_FEATURE,
    ...rowFile(fixtureRow('FW-C-941')),
    ...rowFile(fixtureRow('FW-C-942', { size: 'XL' })),
    ...rowFile(noHint),
    ...rowFile(fixtureRow('FW-C-944')),
  });
  const home = pipelineHome('wo');
  const o = { home, cwd: proj.work };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture');
  for (const id of ['FW-C-941', 'FW-C-942', 'FW-C-943']) {
    const r = fwJson(['ledger', 'retest', id], o);
    check(r.json?.outcome === 'ready', `fw ledger retest ${id} did not make it ready`);
  }

  // Self-verify, with a real registered worker as both doer and verifier.
  let db = await openDbReadonly(home);
  const worker = db.prepare("SELECT id FROM agents WHERE role = 'worker' AND status = 'active' LIMIT 1").get()?.id;
  db.close();
  check(worker, 'no active worker agent registered after sync');
  const self = fw(['wo', 'issue', 'FW-C-941', '--doer', worker, '--verifier', worker, '--json'], o);
  check(self.status !== 0, 'a work order with the same doer and verifier was issued (self-verify)');
  check(/self-verif/i.test(self.stdout + self.stderr), `the self-verify refusal does not say so: ${self.stdout.slice(0, 200)}`);

  const unready = fw(['wo', 'issue', 'FW-C-944', '--json'], o);
  check(unready.status !== 0, 'a work order was issued for a row that is not ready');

  const a = fwJson(['wo', 'issue', 'FW-C-941'], o);
  check(a.status === 0, `fw wo issue FW-C-941 exited ${a.status}: ${a.stdout.slice(0, 200)}`);
  const wa = a.json.work_order;
  check(wa && wa.content_hash === a.json.content_hash, 'the issue report carries no work_order with its content_hash');

  const tmp = join(tmpDir('wo-json'), 'wo.json');
  writeFileSync(tmp, JSON.stringify(wa));
  const v = spawnSync('python3', ['-I', join(root, 'probes/c0/fixtures/validate-json.py'), 'work-order.json', tmp], {
    encoding: 'utf8',
  });
  if (v.status === 3) missing(v.stderr.trim());
  check(v.status === 0, `work order does not validate against work-order.json: ${v.stderr.trim().split('\n')[0]}`);
  check(JSON.stringify(wa.scope?.touches) === JSON.stringify(['fw-fake/**']), `scope.touches ${JSON.stringify(wa.scope?.touches)} is not files_hint`);
  check(
    (wa.acceptance ?? []).some((x) => x.claim === 'the fixture probe passes' && x.probe_command === 'node check-feature.mjs'),
    'acceptance does not carry the row acceptance line and its probe command',
  );
  check(wa.budget?.caps && Object.keys(wa.budget.caps).length > 0, 'budget caps are missing');

  const nh = fwJson(['wo', 'issue', 'FW-C-943'], o);
  check(nh.status === 0, `a row without files_hint does not compile (exit ${nh.status})`);
  const touches = nh.json.work_order?.scope?.touches ?? [];
  check(touches.length > 0, 'a row without files_hint got an empty scope');
  const catchAll = touches.filter((t) => /^(\*\*?(\/\*)?|\.\/?|\/|\*\*\/\*\*?)$/.test(t) || t.startsWith('**'));
  check(catchAll.length === 0, `a row without files_hint got a catch-all scope: ${JSON.stringify(touches)}`);

  // Determinism: recompile the issued order from its own inputs.
  const script = join(home, 'recompile.mts');
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from ${JSON.stringify(join(root, 'packages/eventlog/src/index.ts'))};
import { compileWorkOrder, loadCorePolicy, workOrderHash } from ${JSON.stringify(join(root, 'packages/ledger/src/index.ts'))};
const repo = ${JSON.stringify(proj.work)};
const s = openStore({ path: ${JSON.stringify(dbPath(home))}, readonly: true });
const r = s.reader();
const wo = r.get("SELECT * FROM work_orders WHERE id = ?", [${JSON.stringify(wa.id)}]);
const row = r.get("SELECT * FROM ledger_rows WHERE id = ?", [wo.ledger_row_id]);
const body = JSON.parse(wo.body);
const def = JSON.parse(readFileSync(join(repo, 'ledger/rows/FW-C-941.json'), 'utf8'));
const input = {
  id: wo.id, version: wo.version, issuedAt: new Date(wo.issued_at),
  row: { id: row.id, code: 'FW-C-941', title: row.title, size: row.size, project_id: row.project_id, stream_id: wo.stream_id },
  probe: JSON.parse(row.probe_spec), files_hint: def.files_hint, acceptance: def.acceptance,
  baseCommit: wo.base_commit, policy: loadCorePolicy(repo, ${JSON.stringify(home)}),
  roles: { doer: body.roles.doer, verifier: body.roles.verifier, approver: body.roles.approver.id },
};
const a = compileWorkOrder(input);
const b = compileWorkOrder(input);
console.log(JSON.stringify({ stored: wo.content_hash, a: a.content_hash, b: b.content_hash, rehash: workOrderHash(body), caps: input.policy.sizes.S?.caps }));
s.close();
`,
  );
  const rc = spawnSync(TSX, [script], { encoding: 'utf8', timeout: 60000 });
  check(rc.status === 0, `recompiling the work order failed: ${(rc.stderr || rc.stdout).split('\n')[0]}`);
  const h = JSON.parse(rc.stdout.trim().split('\n').pop());
  check(h.a === h.b, 'two compiles of the same inputs differ (content_hash)');
  check(h.a === h.stored, `recompiling the issued order gives ${h.a}, the stored content_hash is ${h.stored}`);
  check(h.rehash === h.stored, 'the stored work order body does not hash to its content_hash');
  check(
    JSON.stringify(wa.budget.caps) === JSON.stringify(h.caps),
    `budget.caps ${JSON.stringify(wa.budget.caps)} are not the core-policy size S caps ${JSON.stringify(h.caps)}`,
  );

  const xl = fw(['wo', 'issue', 'FW-C-942', '--json'], o);
  check(xl.status !== 0, 'a work order was issued for an XL row');
  check(xl.status === 3, `fw wo issue on an XL row exited ${xl.status}, want 3 (refused by policy)`);
});
