// Probe for FW-C-016 (safety chaos suite): `pnpm probe e2e/safety-chaos`. Tier 0.
// probe-timeout-s: 1500
// Surfaces: the suite under e2e/chaos/, run as `node e2e/chaos/run.mjs --json` with the network cut
// (proxies at a dead port, the fake vendor, a local bare git host).
// The surface this probe expects:
//   node e2e/chaos/run.mjs --json -> { scenarios: [{ name, passed, refusal, base_unchanged, detail? }] }
//     at least 10 scenarios. A refusal scenario (refusal true) is one where the kernel must refuse
//     something; it asserts that nothing landed on the fixture's base branch (base_unchanged true).
//   e2e/chaos/guards.json -> [{ id, describe }]: the guards the suite covers, at least the kill switch,
//     the artifact guard, the diff policy, the secret scan, the budget governor, the merge slot's head
//     check, the approval hash binding and the Tier 0 path check.
//   node e2e/chaos/run.mjs --json --without <guard id> runs the suite with that one guard switched off
//     (a test-only seam that exists only inside the suite) and reports at least one scenario failing.
//
// Proves, in order:
//   1. At least 10 scenarios, all passing, with no network.
//   2. Every refusal scenario left the base branch unchanged.
//   3. Removing any one guard makes at least one scenario fail.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseEnv, check, fail, missing, pipelineEnv, probe, root } from '../c0/_lib.mjs';

const RUNNER = join(root, 'e2e/chaos/run.mjs');
const GUARDS = join(root, 'e2e/chaos/guards.json');
const REQUIRED = ['kill_switch', 'artifact_guard', 'diff_policy', 'secret_scan', 'budget', 'merge_slot_head', 'approval_hash', 'tier0'];

function suite(extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, '--json', ...extra], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600000,
    env: baseEnv(pipelineEnv()),
  });
  if (r.error?.code === 'ETIMEDOUT') fail(`the chaos suite ${extra.join(' ')} did not finish in 10 minutes`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`the chaos suite ${extra.join(' ')} did not print one JSON document (exit ${r.status}): ${(r.stdout + r.stderr).slice(0, 200)}`);
  }
}

await probe('e2e/safety-chaos', async () => {
  if (!existsSync(RUNNER)) missing('e2e/chaos/run.mjs does not exist');
  if (!existsSync(GUARDS)) missing('e2e/chaos/guards.json does not exist');

  // 1 and 2.
  const all = suite();
  const sc = all?.scenarios ?? [];
  check(sc.length >= 10, `the suite has ${sc.length} scenarios, want at least 10`);
  const failed = sc.filter((s) => s.passed !== true);
  check(failed.length === 0, `scenarios failing: ${failed.map((s) => `${s.name} (${s.detail ?? ''})`).join(', ')}`);
  const refusals = sc.filter((s) => s.refusal === true);
  check(refusals.length > 0, 'no scenario is marked as a refusal');
  const landed = refusals.filter((s) => s.base_unchanged !== true);
  check(landed.length === 0, `refusal scenarios that did not prove the base branch unchanged: ${landed.map((s) => s.name).join(', ')}`);

  // 3. Mutation check.
  const guards = JSON.parse(readFileSync(GUARDS, 'utf8'));
  const ids = guards.map((g) => g.id);
  const absent = REQUIRED.filter((id) => !ids.includes(id));
  check(absent.length === 0, `guards.json does not cover: ${absent.join(', ')}`);
  for (const id of ids) {
    const m = suite(['--without', id]);
    const broke = (m?.scenarios ?? []).filter((s) => s.passed !== true);
    check(broke.length >= 1, `with the ${id} guard removed every scenario still passes`);
  }
});
