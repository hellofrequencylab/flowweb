// Probe for FW-C-015 (container sandbox behind FW_SANDBOX=container): `pnpm probe runtime/container-sandbox`.
// Tier 0.
// probe-timeout-s: 600
// Surfaces: prepareSandbox, spawnInSandbox and sandboxSelfTest from packages/daemon/src/index.ts; the
// fw CLI (`fw ledger sync`, `fw run start --adapter fake`) on a fixture project; the database read-only.
// Needs a container runtime (docker or podman) on the machine; without one the probe reports MISSING.
// The surface this probe expects:
//   prepareSandbox({ fwHome, run_id, settings: { mode: "container", egressAllow: [...] } }) returns a
//   sandbox whose spawnInSandbox runs the command inside a container: the run worktree and run dir are
//   mounted, the host home and the container runtime's socket are not, and network egress goes only to
//   egressAllow. A refused connection fails inside the container and is logged, one line naming the
//   host, in <runDir>/egress.log (sb.files.egress). sandboxSelfTest(sb) reports mode "container".
//   fw run start honors FW_SANDBOX=userdir|container; the run.started payload's sandbox.mode says which.
//
// Proves, in order:
//   1. A request from inside the container to a host not on the allowlist fails and is logged.
//   2. The host home and the container socket are not visible inside.
//   3. The fake-vendor run of a fixture row succeeds with FW_SANDBOX=userdir and with FW_SANDBOX=container.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  fixtureProject,
  fw,
  fwJson,
  missing,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  tmpDir,
} from '../c0/_lib.mjs';

const ROW = 'FW-C-015';

function runtimeAvailable() {
  for (const bin of ['docker', 'podman']) {
    const r = spawnSync(bin, ['info'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) return bin;
  }
  return null;
}

function collect(child) {
  return new Promise((ok) => {
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      out += d;
    });
    child.on('exit', (code) => ok({ code, out }));
  });
}

await probe('runtime/container-sandbox', async () => {
  const prepareSandbox = await requireExport('daemon', 'prepareSandbox', ROW);
  const spawnInSandbox = await requireExport('daemon', 'spawnInSandbox', ROW);
  const sandboxSelfTest = await requireExport('daemon', 'sandboxSelfTest', ROW);
  if (!runtimeAvailable()) missing('no container runtime (docker or podman) answers on this machine');

  const fwHome = tmpDir('ctr-home');
  const sb = prepareSandbox({ fwHome, run_id: 'run_probectr1', settings: { mode: 'container', egressAllow: ['registry.npmjs.org'] } });
  check(sb?.mode === 'container', `FW_SANDBOX=container gave a ${sb?.mode} sandbox`);
  const self = await sandboxSelfTest(sb);
  check(self?.mode === 'container', `the self-test reports mode ${self?.mode}, want container`);

  // 1. Egress.
  const net = await collect(
    spawnInSandbox(sb, 'sh', ['-c', 'wget -q -T 5 -O- http://example.com/ >/dev/null 2>&1 || curl -sS -m 5 http://example.com/ >/dev/null 2>&1']),
  );
  check(net.code !== 0, 'a request to a host not on the allowlist succeeded from inside the container');
  const egressLog = sb.files?.egress ?? join(sb.runDir, 'egress.log');
  check(existsSync(egressLog) && /example\.com/.test(readFileSync(egressLog, 'utf8')), 'the refused request is not logged in egress.log');

  // 2. Host home and the runtime socket.
  const host = homedir();
  const seen = await collect(
    spawnInSandbox(sb, 'sh', [
      '-c',
      `for p in "${host}" /var/run/docker.sock /run/docker.sock /run/podman/podman.sock; do [ -e "$p" ] && echo "VISIBLE $p"; done; true`,
    ]),
  );
  check(seen.code === 0, `the visibility check did not run inside the container: ${seen.out.slice(0, 200)}`);
  check(!/VISIBLE/.test(seen.out), `inside the container: ${seen.out.trim()}`);

  // 3. The fake-vendor run under both modes.
  for (const mode of ['userdir', 'container']) {
    const proj = fixtureProject({ rowId: mode === 'userdir' ? 'FW-C-976' : 'FW-C-977' });
    const home = pipelineHome(`ctr-${mode}`);
    const o = { home, cwd: proj.work, env: pipelineEnv({ FW_SANDBOX: mode }), timeoutMs: 300000 };
    check(fw(['ledger', 'sync', '--json'], o).status === 0, `fw ledger sync failed (${mode})`);
    const r = fwJson(['run', 'start', proj.rowId, '--adapter', 'fake'], o);
    check(r.status === 0 && r.json?.status === 'succeeded', `the fake-vendor run failed with FW_SANDBOX=${mode}: ${JSON.stringify(r.json).slice(0, 200)}`);
    const db = await openDbReadonly(home);
    const started = db.prepare("SELECT payload FROM events WHERE type = 'run.started' ORDER BY seq DESC LIMIT 1").get();
    db.close();
    const got = started ? JSON.parse(started.payload).sandbox?.mode : undefined;
    check(got === mode, `run.started reports sandbox mode ${got} with FW_SANDBOX=${mode}`);
  }
});
