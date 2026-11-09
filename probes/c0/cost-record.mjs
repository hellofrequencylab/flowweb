// Probe c0/cost-record (WS-P0-025; backlog verify_probe kernel/cost-record).
// Surface: `fw spend --by agent --json` and `fw run show <run> --json`. The fixture
// (fixtures/cost-fixture.sql) is inserted straight into a database the store created, as a test
// harness would: three runs, two with spend entries, one with none.
// Acceptance:
//   - the rollup equals the sum of the recorded spend for the fixture (per agent, and per run)
//   - missing cost data is reported as unknown, not zero (run_fx000003 has no spend entries)
//   - fw spend --by agent prints the rollup; fw run show <run> prints the run's cost
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, fwJson, openDbAsAttacker, openDbReadonly, probe, root } from './_lib.mjs';

/** All objects anywhere in v. */
function objects(v, out = []) {
  if (v && typeof v === 'object') {
    out.push(v);
    for (const x of Object.values(v)) objects(x, out);
  }
  return out;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

await probe('c0/cost-record', async () => {
  const home = freshHome('cost');
  const init = fwJson(['audit', 'verify'], { home });
  check(init.status === 0, `fw audit verify on a fresh home exited ${init.status} (needed to create the database)`);
  const db = await openDbAsAttacker(home);
  db.exec(readFileSync(join(root, 'probes/c0/fixtures/cost-fixture.sql'), 'utf8'));
  db.close();
  const ro = await openDbReadonly(home);
  const sums = Object.fromEntries(
    ro.prepare('SELECT agent_id, sum(usd) AS usd FROM spend_entries GROUP BY agent_id').all().map((r) => [r.agent_id, r.usd]),
  );
  ro.close();

  const spend = fwJson(['spend', '--by', 'agent'], { home });
  check(spend.status === 0, `fw spend --by agent exited ${spend.status}`);
  for (const [agent, usd] of Object.entries(sums)) {
    const hit = objects(spend.json).find(
      (o) => Object.values(o).includes(agent) && Object.values(o).some((v) => typeof v === 'number' && near(v, usd)),
    );
    check(hit, `fw spend --by agent does not report ${usd} USD for ${agent}`);
  }

  const r1 = fwJson(['run', 'show', 'run_fx000001'], { home });
  check(r1.status === 0, `fw run show run_fx000001 exited ${r1.status}`);
  check(
    objects(r1.json).some((o) => Object.values(o).some((v) => typeof v === 'number' && near(v, 0.1875))),
    'fw run show run_fx000001 does not report its 0.1875 USD rollup',
  );

  const r3 = fwJson(['run', 'show', 'run_fx000003'], { home });
  check(r3.status === 0, `fw run show run_fx000003 exited ${r3.status}`);
  const text = JSON.stringify(r3.json);
  check(/"unknown"/.test(text), 'a run with no cost data is not reported as "unknown"');
  const zeroCost = objects(r3.json).some((o) =>
    Object.entries(o).some(([k, v]) => /cost|usd/i.test(k) && v === 0),
  );
  check(!zeroCost, 'a run with no cost data is reported with a cost of 0');
});
