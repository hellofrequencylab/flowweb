// Probe c0/walking-skeleton-ci (WS-P0-042; backlog verify_probe e2e/walking-skeleton-ci).
// Surface: the CI end-to-end test e2e/walking-skeleton.test.ts, run with vitest exactly as CI would,
// plus the probe c0/run-fake-e2e under the same conditions.
// Acceptance:
//   - runs with no network and no keys (proxies to a dead port, every *KEY*/*TOKEN*/*SECRET*
//     variable removed, FW_LIVE_VENDORS unset)
//   - asserts PR, bundle, audit chain and cost rollup (the test file must reference each; the
//     behaviour itself is c0/run-fake-e2e, which runs here too)
//   - completes in under 90 s in CI (measured here for the e2e test file)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseEnv, check, missing, probe, root, runProbe } from './_lib.mjs';

await probe('c0/walking-skeleton-ci', async () => {
  const file = join(root, 'e2e/walking-skeleton.test.ts');
  if (!existsSync(file)) missing('e2e/walking-skeleton.test.ts does not exist (row WS-P0-042)');
  const text = readFileSync(file, 'utf8');
  for (const [what, re] of [
    ['the PR', /pull_request|\bPR\b/],
    ['the evidence bundle', /evidence|bundle/i],
    ['the audit chain', /audit|verifyChain|chain/i],
    ['the cost rollup', /spend|cost/i],
  ]) {
    check(re.test(text), `e2e/walking-skeleton.test.ts does not assert ${what}`);
  }
  const env = baseEnv({ HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' });
  delete env.FW_LIVE_VENDORS;
  const started = Date.now();
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', 'e2e/walking-skeleton.test.ts'], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 180000,
  });
  const ms = Date.now() - started;
  check(r.status === 0, `e2e/walking-skeleton.test.ts failed: ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
  check(ms < 90000, `e2e/walking-skeleton.test.ts took ${ms} ms, want under 90000`);
  check(runProbe('c0/run-fake-e2e') === 0, 'c0/run-fake-e2e failed under CI conditions');
});
