// Probe c0/cost-record (WS-P0-025; backlog verify_probe kernel/cost-record).
// Surfaces: `fw run start` (fake vendor) for a real cost record; `fw run show <run> --json` (cost:
// { usd, entries, known }) and its text form; fwd's `GET /v1/spend?group_by=agent`; `fw spend --by
// agent`; the database. The fixture (fixtures/cost-fixture.sql) is inserted straight into a database
// the CLI created, as a test harness would: three runs by two agents, two with spend, one with none.
// Acceptance:
//   - the rollup equals the sum of the run's spend: for a real fake run, and for each fixture run
//     and agent, the reported figure equals the SQL sum of spend_entries
//   - missing cost data is reported as unknown, not zero (run_fx000003: usd null, known false, and
//     the text form says unknown)
//   - fw spend --by agent prints the rollup per agent (open: the CLI has no `fw spend`; the daemon
//     API has the same rollup, checked here first); per run: fw run show <run>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  DAEMON_BIN,
  killAndWait,
  fixtureProject,
  fw,
  fwJson,
  openDbAsAttacker,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  root,
  spawnTs,
  waitFor,
} from './_lib.mjs';

const near = (a, b) => Math.abs(a - b) < 1e-9;

await probe('c0/cost-record', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-951' });
  const home = pipelineHome('cost');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');

  // A real run: its rollup equals the sum of its spend entries.
  const run = fwJson(['run', 'start', 'FW-C-951', '--adapter', 'fake'], o);
  check(run.status === 0, `fw run start FW-C-951 exited ${run.status}: ${run.stdout.slice(0, 200)}`);
  const runId = run.json.run_id;
  let db = await openDbReadonly(home);
  const real = db.prepare('SELECT count(*) AS n, sum(usd) AS usd FROM spend_entries WHERE run_id = ?').get(runId);
  db.close();
  check(real.n >= 1, 'the fake run recorded no spend entries');
  const shown = fwJson(['run', 'show', runId], o);
  check(shown.status === 0, `fw run show ${runId} exited ${shown.status}`);
  check(near(shown.json.cost?.usd, real.usd), `fw run show reports ${shown.json.cost?.usd} USD, spend_entries sum to ${real.usd}`);
  check(shown.json.cost?.entries === real.n && shown.json.cost?.known === true, 'fw run show does not report the entry count as known');
  check(near(run.json.cost_usd, real.usd), `fw run start reported cost_usd ${run.json.cost_usd}, spend_entries sum to ${real.usd}`);

  // The fixture.
  const attacker = await openDbAsAttacker(home);
  attacker.exec(readFileSync(join(root, 'probes/c0/fixtures/cost-fixture.sql'), 'utf8'));
  attacker.close();
  db = await openDbReadonly(home);
  const sums = Object.fromEntries(
    db
      .prepare("SELECT agent_id, sum(usd) AS usd FROM spend_entries WHERE run_id LIKE 'run_fx%' GROUP BY agent_id")
      .all()
      .map((r) => [r.agent_id, r.usd]),
  );
  const allByAgent = Object.fromEntries(
    db.prepare('SELECT agent_id, sum(usd) AS usd FROM spend_entries GROUP BY agent_id').all().map((r) => [r.agent_id, r.usd]),
  );
  db.close();
  check(Object.keys(sums).length === 2, 'the cost fixture did not load');

  const r1 = fwJson(['run', 'show', 'run_fx000001'], o);
  check(r1.status === 0, `fw run show run_fx000001 exited ${r1.status}`);
  check(near(r1.json.cost?.usd, 0.1875), `fw run show run_fx000001 reports ${r1.json.cost?.usd}, want 0.1875 (two entries)`);

  const r3 = fwJson(['run', 'show', 'run_fx000003'], o);
  check(r3.status === 0, `fw run show run_fx000003 exited ${r3.status}`);
  check(r3.json.cost?.usd === null && r3.json.cost?.known === false, `a run with no cost data reports ${JSON.stringify(r3.json.cost)}, want usd null and known false`);
  const t3 = fw(['run', 'show', 'run_fx000003'], o);
  check(/unknown/i.test(t3.stdout) && !/\$0(\.0+)?\b|0\.0000/.test(t3.stdout), 'the text form of fw run show does not say the cost is unknown');

  // Per agent through the daemon API.
  const fwd = spawnTs(DAEMON_BIN, ['--home', home, '--port', '0'], { env: { FW_HOME: home, FW_DEV_NO_AUTH: '1' } });
  try {
    const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(fwd.output())?.[1], {
      timeoutMs: 30000,
      what: 'fwd to listen',
    });
    const res = await fetch(`${url}/v1/spend?group_by=agent`);
    check(res.ok, `GET /v1/spend?group_by=agent answered ${res.status}`);
    const rows = (await res.json()).data ?? [];
    for (const [agent, usd] of Object.entries(allByAgent)) {
      const hit = rows.find((r) => r.agent_id === agent);
      check(hit && near(hit.usd, usd), `GET /v1/spend?group_by=agent reports ${hit?.usd} for ${agent}, the SQL sum is ${usd}`);
    }
  } finally {
    await killAndWait(fwd);
  }

  // The CLI command the row names.
  const spend = fwJson(['spend', '--by', 'agent'], o);
  check(spend.status === 0, `fw spend --by agent exited ${spend.status} (the row names this command; the CLI does not have it)`);
  const text = JSON.stringify(spend.json);
  for (const [agent, usd] of Object.entries(allByAgent)) {
    check(text.includes(agent) && text.includes(String(usd)), `fw spend --by agent does not report ${usd} USD for ${agent}`);
  }
});
