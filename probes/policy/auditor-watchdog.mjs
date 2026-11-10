// Probe for FW-C-013 (Auditor and Watchdog as deterministic checks): `pnpm probe policy/auditor-watchdog`.
// Tier 0.
// probe-timeout-s: 240
// Surfaces: `fw ledger sync` and `fw run start --adapter fake` on a fixture project (for a real run and
// agent); the exports below, called with the Writer of the Store port; the database (read-only, plus a
// direct write as an attacker to flip a byte in an old event).
// The surface this probe expects:
//   auditRun({ writer, run_id, transcript: { turns: string[], tool_calls: [{ name, command? }] } })
//     [@fw/daemon] -> { mismatches: [{ kind, excerpt }] }. A turn that claims tests passed, with no
//     tool call that ran tests, is a mismatch of kind "tests_passed": it records one run.claim_mismatch
//     (payload names run_id and agent_id) and sets that agent's status to quarantined. A transcript
//     whose claim is backed by a test tool call gives no mismatch and changes nothing.
//   watchdogCycle({ writer }) [@fw/daemon] -> { chain_ok, engaged }: verifies the event chain; when it
//     is broken it records audit.chain_verification_failed and engages the kill switch.
//   FAILSAFES [@fw/policy]: [{ id, event_type, test }], every fail-safe and the test that proves it
//     emits its event; checkFailsafes({ root, registry? }) -> problems [{ id, reason }]: an entry whose
//     test file does not exist or never names its event_type is a problem. A test under
//     packages/policy/test/ calls checkFailsafes, so `pnpm -r test` (CI) fails on a problem.
//
// Proves, in order:
//   1. A planted "tests passed" claim with no test tool call raises run.claim_mismatch and quarantines
//      the agent; a backed claim does not.
//   2. A byte flipped in an old event is caught by one watchdog cycle, which engages the kill switch.
//   3. The fail-safe registry is clean, a planted entry with no emitting test is a problem, and the
//      check runs in the policy package's tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  count,
  dbPath,
  fixtureProject,
  fw,
  fwJson,
  openDbAsAttacker,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  root,
} from '../c0/_lib.mjs';

const ROW = 'FW-C-013';

await probe('policy/auditor-watchdog', async () => {
  const auditRun = await requireExport('daemon', 'auditRun', ROW);
  const watchdogCycle = await requireExport('daemon', 'watchdogCycle', ROW);
  const FAILSAFES = await requireExport('policy', 'FAILSAFES', ROW);
  const checkFailsafes = await requireExport('policy', 'checkFailsafes', ROW);
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-975' });
  const home = pipelineHome('auditor');
  const o = { home, cwd: proj.work, env: pipelineEnv(), timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  const run = fwJson(['run', 'start', 'FW-C-975', '--adapter', 'fake'], o);
  check(run.status === 0 && run.json?.run_id, `fw run start exited ${run.status}`);
  const runId = run.json.run_id;
  let db = await openDbReadonly(home);
  const agentId = db.prepare('SELECT agent_id FROM runs WHERE id = ?').get(runId)?.agent_id;
  db.close();
  check(agentId, 'the run has no agent_id');

  const withWriter = async (fn) => {
    const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
    try {
      return await fn(store.writer);
    } finally {
      store.close();
    }
  };

  // 1. Claims.
  const backed = await withWriter((w) =>
    auditRun({
      writer: w,
      run_id: runId,
      transcript: { turns: ['I ran the tests and all 12 passed.'], tool_calls: [{ name: 'bash', command: 'pnpm test' }] },
    }),
  );
  check(Array.isArray(backed?.mismatches) && backed.mismatches.length === 0, 'a claim backed by a test tool call was flagged');
  const planted = await withWriter((w) =>
    auditRun({
      writer: w,
      run_id: runId,
      transcript: { turns: ['Done. All tests passed.'], tool_calls: [{ name: 'edit', command: 'write src/a.ts' }] },
    }),
  );
  check(planted?.mismatches?.some((m) => m.kind === 'tests_passed'), 'a tests-passed claim with no test tool call was not flagged');
  db = await openDbReadonly(home);
  const ev = db
    .prepare("SELECT payload FROM events WHERE type = 'run.claim_mismatch'")
    .all()
    .map((e) => JSON.parse(e.payload));
  check(ev.length === 1 && ev[0].run_id === runId && ev[0].agent_id === agentId, `want one run.claim_mismatch naming the run and agent, got ${JSON.stringify(ev)}`);
  check(db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId)?.status === 'quarantined', 'the agent was not quarantined');
  db.close();

  // 2. Watchdog.
  const clean = await withWriter((w) => watchdogCycle({ writer: w }));
  check(clean?.chain_ok === true && clean.engaged === false, `a watchdog cycle on an intact chain gave ${JSON.stringify(clean)}`);
  const attacker = await openDbAsAttacker(home);
  for (const t of attacker.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'").all()) {
    attacker.exec(`DROP TRIGGER "${t.name}"`);
  }
  const old = attacker.prepare('SELECT seq, payload FROM events ORDER BY seq LIMIT 1 OFFSET 2').get();
  const flipped = old.payload.replace(/[a-z]/, (c) => (c === 'a' ? 'b' : 'a'));
  attacker.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(flipped, old.seq);
  attacker.close();
  const broken = await withWriter((w) => watchdogCycle({ writer: w }));
  check(broken?.chain_ok === false && broken.engaged === true, `one watchdog cycle after a flipped byte gave ${JSON.stringify(broken)}`);
  db = await openDbReadonly(home);
  check(count(db, "SELECT count(*) FROM events WHERE type = 'audit.chain_verification_failed'") === 1, 'want one audit.chain_verification_failed');
  check(
    count(db, "SELECT count(*) FROM settings WHERE key = 'kill_switch' AND json_extract(value, '$.engaged') = 1") === 1,
    'the watchdog did not engage the kill switch',
  );
  db.close();

  // 3. Fail-safe registry.
  check(Array.isArray(FAILSAFES) && FAILSAFES.length > 0, 'FAILSAFES is empty');
  for (const t of ['run.claim_mismatch', 'audit.chain_verification_failed', 'system.kill_switch_engaged']) {
    check(FAILSAFES.some((f) => f.event_type === t), `FAILSAFES has no entry for ${t}`);
  }
  const problems = checkFailsafes({ root });
  check(Array.isArray(problems) && problems.length === 0, `the fail-safe registry has problems: ${JSON.stringify(problems).slice(0, 300)}`);
  const plantedReg = [...FAILSAFES, { id: 'probe_unproven', event_type: 'probe.never_emitted', test: FAILSAFES[0].test }];
  const found = checkFailsafes({ root, registry: plantedReg });
  check(found.length === 1 && found[0].id === 'probe_unproven', `a fail-safe with no emitting test was not reported: ${JSON.stringify(found)}`);
  const testDir = join(root, 'packages/policy/test');
  const wired = readdirSync(testDir, { recursive: true })
    .filter((f) => String(f).endsWith('.test.ts'))
    .some((f) => readFileSync(join(testDir, String(f)), 'utf8').includes('checkFailsafes'));
  check(wired, 'no test under packages/policy/test/ calls checkFailsafes, so CI would not fail on an unproven fail-safe');
});
