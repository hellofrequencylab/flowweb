// Probe c0/probe-runner (WS-P0-006; backlog verify_probe devex/probe-runner). Tested through
// probe-timeout-s: 240 (measures the real 60 s default, so it needs longer itself)
// `pnpm probe <path>` (the runner, wherever it lives).
// Acceptance:
//   - a probe whose target does not exist exits nonzero (fixture c0/fixtures/target-missing)
//   - a missing probe file exits 2 with a clear message, not 0
//   - probe runs are time-limited by default (60 s): a never-ending probe is stopped between 55 and
//     75 s with a nonzero exit and a message naming the timeout, and its child processes are gone.
// Takes about a minute because it measures the real default.
import { spawnSync } from 'node:child_process';
import { check, pidsWithMarker, probe, root, sleep } from './_lib.mjs';

function pnpmProbe(path, env = {}, timeout = 120000) {
  const started = Date.now();
  const r = spawnSync('pnpm', ['-s', 'probe', path], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });
  return { ...r, ms: Date.now() - started, out: `${r.stdout}${r.stderr}` };
}

await probe('c0/probe-runner', async () => {
  const m = pnpmProbe('c0/fixtures/target-missing');
  check(m.status !== 0 && m.status !== null, `a probe whose target is missing exited ${m.status}, want nonzero`);

  const nf = pnpmProbe('c0/does-not-exist-anywhere');
  check(nf.status === 2, `a missing probe file exited ${nf.status}, want 2`);
  check(/not found/i.test(nf.out), `missing probe message is not clear: ${nf.out.trim().split('\n')[0]}`);

  const marker = `fw-probe-runner-${process.pid}-${Date.now()}`;
  const t = pnpmProbe('c0/fixtures/sleep-forever', { FW_PROBE_MARKER: marker }, 150000);
  await sleep(500);
  const left = pidsWithMarker(marker);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL'); // clean up before judging, so a failing run leaves nothing behind
    } catch {}
  }
  check(t.error?.code !== 'ETIMEDOUT', 'the runner did not stop a never-ending probe within 150 s (no default limit)');
  check(t.status !== 0, 'a timed-out probe was reported as exit 0');
  check(t.ms >= 55000 && t.ms <= 75000, `timed-out probe stopped after ${t.ms} ms, want about 60000 (default 60 s)`);
  check(/time(d)? ?out|timeout/i.test(t.out), `the runner output does not say the probe timed out: ${t.out.trim().split('\n').pop()}`);
  check(left.length === 0, `processes started by the timed-out probe are still running: ${left.join(', ')}`);
});
