// Probe for WS-P1-012 (budget governor: per-run caps and refusal): `pnpm probe policy/budget-governor`.
// Tier 0.
// probe-timeout-s: 240
// Surfaces: `fw ledger sync`, `fw run start <row> --adapter fake --json` in a fixture project, the
// database read-only, and policy/tier0-paths.json with scripts/check-tier0.mjs.
// The surface this probe expects:
//   policy/budgets.json (Tier 0, in the repo fwd runs on) holds stream envelopes:
//     { "streams": { "<stream key>": { "max_usd_per_run": <number> } } }
//   Before a run is admitted, the governor compares the work order's budget.caps.max_usd with the
//   envelope of its stream. When the order asks for more, the run is refused before it starts: fw run
//   start exits nonzero, no run of that order reaches starting, and exactly one dispatch.refused_budget
//   event records it with payload { cap: { scope: "stream", stream_key, max_usd_per_run },
//   requested: { max_usd }, source: "policy/budgets.json" }. Within the envelope the run starts as
//   before. No envelope for a stream means no stream cap (the existing budgets still apply).
//
// Proves, in order:
//   1. policy/budgets.json is a Tier 0 path: scripts/check-tier0.mjs refuses an agent PR changing it.
//   2. With an envelope below the order's cap, fw run start is refused, no run starts, and one
//      dispatch.refused_budget names the cap and the requested amount.
//   3. With the envelope raised above the order's cap, the same row's run starts (run.started).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  count,
  fixtureProject,
  fw,
  git,
  missing,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  root,
  writeFiles,
} from '../c0/_lib.mjs';

const ROW = 'FW-C-971';

await probe('policy/budget-governor', async () => {
  // 1. Tier 0.
  const tier0 = await import(pathToFileURL(join(root, 'scripts/check-tier0.mjs')).href);
  const covered = tier0.TIER0.some((p) => tier0.patternToRegExp(p).test('policy/budgets.json'));
  check(covered, 'policy/budgets.json is not covered by policy/tier0-paths.json');

  const proj = fixtureProject({ rowId: ROW });
  const setEnvelope = (usd, msg) => {
    writeFiles(proj.work, {
      'policy/budgets.json': `${JSON.stringify({ streams: { backlog: { max_usd_per_run: usd } } }, null, 2)}\n`,
    });
    git(proj.work, 'add', '.');
    git(proj.work, 'commit', '-qm', msg);
    git(proj.work, 'push', '-q', 'origin', 'main');
  };
  setEnvelope(0.01, 'tight envelope');
  const home = pipelineHome('budget');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');

  // 2. Refused.
  const r = fw(['run', 'start', ROW, '--adapter', 'fake', '--json'], o);
  check(r.status !== 0, 'fw run start succeeded with an order cap above the stream envelope');
  let db = await openDbReadonly(home);
  const refusals = db
    .prepare("SELECT payload FROM events WHERE type = 'dispatch.refused_budget' ORDER BY seq")
    .all()
    .map((e) => JSON.parse(e.payload));
  if (refusals.length === 0) missing('no dispatch.refused_budget for a run above its stream envelope (no budget governor)');
  check(refusals.length === 1, `${refusals.length} dispatch.refused_budget events for one refused run, want 1`);
  const p = refusals[0];
  check(p.cap?.scope === 'stream', `refusal cap.scope is ${JSON.stringify(p.cap?.scope)}, want "stream"`);
  check(p.cap?.max_usd_per_run === 0.01, `refusal cap.max_usd_per_run is ${p.cap?.max_usd_per_run}, want 0.01`);
  check(typeof p.requested?.max_usd === 'number' && p.requested.max_usd > 0.01, `refusal requested.max_usd is ${p.requested?.max_usd}`);
  check(p.source === 'policy/budgets.json', `refusal source is ${JSON.stringify(p.source)}`);
  check(
    count(db, "SELECT count(*) FROM runs WHERE status NOT IN ('queued','cancelled')") === 0,
    'a run went past admission although the governor refused it',
  );
  check(count(db, "SELECT count(*) FROM events WHERE type = 'run.started'") === 0, 'a run.started was recorded for a refused run');
  db.close();

  // 3. Raised envelope: the run starts.
  setEnvelope(100, 'roomy envelope');
  const ok = fw(['run', 'start', ROW, '--adapter', 'fake', '--json'], o);
  db = await openDbReadonly(home);
  const started = count(db, "SELECT count(*) FROM events WHERE type = 'run.started'");
  const refusedAfter = count(db, "SELECT count(*) FROM events WHERE type = 'dispatch.refused_budget'");
  db.close();
  check(started >= 1, `with the envelope raised the run did not start (exit ${ok.status}): ${(ok.stdout + ok.stderr).slice(0, 200)}`);
  check(refusedAfter === 1, 'a run within its envelope was refused by the budget governor');
});
