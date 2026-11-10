// Probe for WS-P1-035 (dev-from-backlog stream template): `pnpm probe workstreams/dev-template`. Tier 0.
// probe-timeout-s: 240
// Surfaces: devFromBacklog exported by packages/daemon/src/index.ts; the fw CLI (`fw ledger sync`,
// `fw ledger retest`, `fw stream add -f`, `fw stream run`) on a fixture project with the fake vendor
// and a local bare git host; contracts-core/json-schema/stream-definition.json; the database read-only.
// The surface this probe expects:
//   devFromBacklog({ project_id }) [@fw/daemon] -> a stream definition (stream-definition.json) for
//     the project's dev stream: it works the backlog by picking the next ready ledger row. Its source,
//     packages/daemon/src/streams/src/templates/dev-from-backlog.ts, and the definition name no vendor.
//   fw stream add -f <file> --json stores it (as for any stream).
//   fw stream run <stream key> --adapter fake --json fires the stream once and prints the fw run start
//     report of the row it picked (code, run_id, status, pr).
//
// Proves, in order:
//   1. The definition validates and names no vendor, nor does the template source.
//   2. fw stream add -f creates the stream.
//   3. Firing it picks the next ready row (not one whose dependency is open) and the run ends with a PR
//      and an evidence bundle for that row.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_FEATURE,
  check,
  count,
  fixtureRow,
  fw,
  fwJson,
  missing,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  projectFromFiles,
  requireExport,
  root,
  rowFile,
  tmpDir,
} from '../c0/_lib.mjs';

const ROW = 'WS-P1-035';
const VENDORS = /\b(claude|codex|anthropic|openai|gpt|gemini|google)\b/i;

await probe('workstreams/dev-template', async () => {
  const devFromBacklog = await requireExport('daemon', 'devFromBacklog', ROW);
  const src = join(root, 'packages/daemon/src/streams/src/templates/dev-from-backlog.ts');
  if (!existsSync(src)) missing('packages/daemon/src/streams/src/templates/dev-from-backlog.ts does not exist');
  check(!VENDORS.test(readFileSync(src, 'utf8')), 'the template source names a vendor');

  const proj = projectFromFiles({
    'check-feature.mjs': CHECK_FEATURE,
    ...rowFile(fixtureRow('FW-C-978')),
    ...rowFile(fixtureRow('FW-C-979', { depends_on: ['FW-C-980'] })),
    ...rowFile(fixtureRow('FW-C-980')),
  });
  const home = pipelineHome('devtpl');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 180000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  for (const id of ['FW-C-978', 'FW-C-980']) check(fwJson(['ledger', 'retest', id], o).json?.outcome === 'ready', `${id} did not become ready`);
  let db = await openDbReadonly(home);
  const projectId = db.prepare("SELECT project_id FROM ledger_rows WHERE id = 'lr_FWC978'").get()?.project_id;
  db.close();

  // 1. The definition.
  const def = devFromBacklog({ project_id: projectId });
  check(def && typeof def === 'object' && def.key, 'devFromBacklog returned no definition');
  check(!VENDORS.test(JSON.stringify(def)), 'the stream definition names a vendor');
  const file = join(tmpDir('devtpl'), 'dev.json');
  writeFileSync(file, JSON.stringify(def));
  const v = spawnSync('python3', ['-I', join(root, 'probes/c0/fixtures/validate-json.py'), 'stream-definition.json', file], { encoding: 'utf8' });
  if (v.status === 3) missing(v.stderr.trim());
  check(v.status === 0, `the definition does not validate: ${v.stderr.trim().split('\n')[0]}`);

  // 2. Add it.
  const add = fwJson(['stream', 'add', '-f', file], o);
  check(add.status === 0, `fw stream add -f exited ${add.status}: ${(add.stdout + add.stderr).slice(0, 200)}`);

  // 3. Fire it.
  const run = fw(['stream', 'run', def.key, '--adapter', 'fake', '--json'], o);
  if (run.status !== 0 && /unknown command|"USAGE"/i.test(run.stdout + run.stderr)) missing('fw stream run does not exist');
  check(run.status === 0, `fw stream run exited ${run.status}: ${(run.stdout + run.stderr).slice(0, 300)}`);
  const rep = JSON.parse(run.stdout);
  check(['FW-C-978', 'FW-C-980'].includes(rep.code), `the stream picked ${rep.code}, want a ready row (FW-C-978 or FW-C-980), never FW-C-979`);
  check(rep.status === 'succeeded' && rep.pr?.url, `the stream's run did not end with a PR: ${JSON.stringify(rep).slice(0, 200)}`);
  db = await openDbReadonly(home);
  const rowId = `lr_${rep.code.replaceAll('-', '')}`;
  check(count(db, "SELECT count(*) FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request' AND verified_by_kernel = 1", rep.run_id) === 1, 'no kernel-verified PR artifact');
  check(count(db, 'SELECT count(*) FROM evidence_bundles WHERE subject_ref = ? OR subject_ref = ? OR body LIKE ?', rowId, rep.code, `%${rep.run_id}%`) >= 1, 'no evidence bundle for the run');
  check(
    count(db, 'SELECT count(*) FROM runs r JOIN streams s ON s.id = r.stream_id WHERE r.id = ? AND s.key = ?', rep.run_id, def.key) === 1,
    'the run is not attributed to the dev stream',
  );
  db.close();
});
