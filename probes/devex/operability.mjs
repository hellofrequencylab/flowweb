// Probe for FW-C-029 (operability: doctor, service units, backup and restore): `pnpm probe devex/operability`.
// Tier 0.
// probe-timeout-s: 360
// Surfaces: the fw CLI (`fw doctor`, `fw backup`, `fw restore`, `fw audit verify`, `fw ledger list`,
// `fw run start`) on a fixture project; a real fwd (probes/lib/fwd.mjs) killed with SIGKILL mid-run
// and started again the way its service unit restarts it; the unit files under ops/; the database
// read-only.
// The surface this probe expects:
//   fw doctor --json -> { checks: [{ name, status: "pass" | "warn" | "fail", detail }] }; exit
//     nonzero exactly when a check failed; nothing it prints holds a secret value (from the
//     environment or from $FW_HOME/creds). A core policy that does not parse is a failed check.
//   ops/ holds a systemd user unit (ops/systemd/fwd.service, Restart=always or on-failure) and a
//     launchd agent (ops/launchd/*.plist, KeepAlive true), so a SIGKILLed fwd is started again.
//   When fwd starts after a SIGKILL, a run that was in flight is ended and marked interrupted: it is
//     no longer starting, running or validating, and its ending event's payload says "interrupted".
//   fw backup --out <file> --json -> { path, db_hash } and one system.backup_completed event;
//   fw restore <file> --json into an empty FW_HOME restores it: fw audit verify is ok there and
//   fw ledger list shows the same rows.
//
// Proves, in order:
//   1. fw doctor prints no secret, and exits nonzero exactly when a check failed.
//   2. The service units restart fwd; after a SIGKILL mid-run and a restart the run is interrupted.
//   3. A backup restored into a clean home verifies its chain and lists the same rows.
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_BIN,
  check,
  count,
  fakeSecret,
  fixtureProject,
  freshHome,
  fw,
  fwJson,
  killAndWait,
  missing,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  root,
  spawnTs,
  tmpDir,
  waitFor,
} from '../c0/_lib.mjs';
import { freePort, startFwd } from '../lib/fwd.mjs';

await probe('devex/operability', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-993', scenario: 'hang', extraRows: [{ id: 'FW-C-994' }] });
  const home = pipelineHome('ops');
  const port = await freePort();
  const secret = fakeSecret('anthropic');
  mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'creds', 'crd_fake0001'), `${secret}\n`, { mode: 0o600 });
  const env = pipelineEnv({ FW_PORT: String(port), ANTHROPIC_API_KEY: secret });
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed');

  // 1. Doctor.
  const doc = fw(['doctor', '--json'], o);
  if (/unknown command|"USAGE"/i.test(doc.stdout + doc.stderr) && doc.status !== 0) missing('fw doctor does not exist');
  check(!(doc.stdout + doc.stderr).includes(secret), 'fw doctor printed a secret value');
  const report = JSON.parse(doc.stdout);
  check(Array.isArray(report.checks) && report.checks.length > 0, 'fw doctor --json has no checks list');
  const failed = (report.checks ?? []).filter((c) => c.status === 'fail');
  check((doc.status !== 0) === failed.length > 0, `fw doctor exited ${doc.status} with ${failed.length} failed checks`);
  const broken = pipelineHome('ops-broken');
  writeFileSync(join(broken, 'config/core-policy.yaml'), 'rules: [this is: not: valid yaml\n');
  const bad = fw(['doctor', '--json'], { ...o, home: broken });
  check(!(bad.stdout + bad.stderr).includes(secret), 'fw doctor printed a secret value on a broken home');
  check(bad.status !== 0, 'fw doctor exited 0 although the core policy does not parse');
  check(JSON.parse(bad.stdout).checks?.some((c) => c.status === 'fail'), 'fw doctor reported no failed check for an unparsable policy');

  // 2. Service units and a SIGKILL mid-run.
  const unit = join(root, 'ops/systemd/fwd.service');
  check(existsSync(unit) && /^Restart=(always|on-failure)\s*$/m.test(readFileSync(unit, 'utf8')), 'ops/systemd/fwd.service does not restart fwd');
  const plists = existsSync(join(root, 'ops/launchd')) ? readdirSync(join(root, 'ops/launchd')).filter((f) => f.endsWith('.plist')) : [];
  check(
    plists.some((f) => /<key>KeepAlive<\/key>\s*<true\/>/.test(readFileSync(join(root, 'ops/launchd', f), 'utf8'))),
    'ops/launchd has no plist with KeepAlive true',
  );
  let fwd = await startFwd(home, { env, port });
  const runner = spawnTs(CLI_BIN, ['run', 'start', 'FW-C-993', '--adapter', 'fake', '--scenario', 'hang', '--max-wall-clock-s', '240', '--json'], {
    cwd: proj.work,
    env: { FW_HOME: home, ...env },
  });
  try {
    const running = async () => {
      const db = await openDbReadonly(home);
      try {
        return db.prepare("SELECT id FROM runs WHERE status = 'running'").get()?.id;
      } finally {
        db.close();
      }
    };
    const runId = await waitFor(running, { timeoutMs: 60000, what: 'the hang run to reach running' });
    await fwd.stop('SIGKILL');
    fwd = await startFwd(home, { env, port });
    await waitFor(
      async () => {
        const db = await openDbReadonly(home);
        try {
          return db.prepare("SELECT status FROM runs WHERE id = ? AND status NOT IN ('starting','running','validating')").get(runId);
        } finally {
          db.close();
        }
      },
      { timeoutMs: 30000, what: 'the in-flight run to be ended after the restart' },
    );
    const db = await openDbReadonly(home);
    const ended = db
      .prepare("SELECT payload FROM events WHERE run_id = ? AND type IN ('run.failed','run.killed','run.timed_out','run.interrupted') ORDER BY seq DESC LIMIT 1")
      .get(runId);
    db.close();
    check(ended && /interrupted/.test(ended.payload), `the in-flight run is not marked interrupted: ${ended?.payload?.slice(0, 200)}`);
  } finally {
    await killAndWait(runner);
    await fwd.stop();
  }

  // 3. Backup and restore.
  const out = join(tmpDir('backup'), 'fw-backup.tar');
  const b = fwJson(['backup', '--out', out], o);
  check(b.status === 0 && existsSync(out), `fw backup exited ${b.status}: ${(b.stdout + b.stderr).slice(0, 200)}`);
  let db = await openDbReadonly(home);
  check(count(db, "SELECT count(*) FROM events WHERE type = 'system.backup_completed'") === 1, 'want one system.backup_completed');
  db.close();
  const clean = freshHome('restored');
  const r = fwJson(['restore', out], { ...o, home: clean });
  check(r.status === 0, `fw restore exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)}`);
  const v = fwJson(['audit', 'verify'], { ...o, home: clean });
  check(v.status === 0 && v.json?.ok === true, 'the restored chain does not verify');
  const codes = (h) => {
    const l = fwJson(['ledger', 'list'], { ...o, home: h });
    const rows = Array.isArray(l.json) ? l.json : (l.json?.rows ?? []);
    return rows.map((x) => x.code ?? x.id).sort().join(',');
  };
  check(codes(clean) === codes(home), 'the restored home lists different rows');
});
