// Probe c0/probe-exec (WS-P0-019; backlog verify_probe kernel/probe-exec).
// Surfaces: `fw ledger retest <ID> --json` (runs the row's probe and records it), runRowProbe from
// packages/ledger/src/index.ts (the executor every probe run goes through; its timeoutMs option
// stands in for the stored 600 s limit so the test does not wait ten minutes), and the database.
// Acceptance:
//   - a probe exceeding its timeout is killed (its whole process group) and recorded as fail
//     (ledger.probe_executed status fail, timed_out true; ledger_rows.last_probe_status fail); the
//     stored probe of every synced row carries a timeout
//   - a modified probe is refused with tamper_detected and nothing runs. Two cases:
//       a) the stored probe definition no longer matches its probe_hash: refused, audit.finding_raised
//       b) the probe FILE differs from probes/MANIFEST.sha256: refused (open: the executor does not
//          read a manifest yet, and the Owner has not created the repo's manifest; items 19 and 20)
//   - the result event (ledger.probe_executed) carries the stdout tail, exit code and duration
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  count,
  dbPath,
  fixtureRow,
  fw,
  fwJson,
  openDbAsAttacker,
  openDbReadonly,
  pidsWithMarker,
  pipelineHome,
  probe,
  projectFromFiles,
  root,
  rowFile,
  rowStatusOf,
  sha256,
  TSX,
} from './_lib.mjs';

const marker = `fw-probe-exec-${process.pid}`;
const OUT = "console.log('probe-exec fixture output line');\nconsole.log('tail-marker-42');\nprocess.exit(1);\n";
const SLOW = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '${marker}'], { stdio: 'ignore' });\nsetTimeout(() => {}, 300000);\n`;

const lastProbeEvent = (db, code) =>
  db
    .prepare("SELECT payload FROM events WHERE type = 'ledger.probe_executed' ORDER BY seq DESC")
    .all()
    .map((e) => JSON.parse(e.payload))
    .find((p) => p.code === code);

await probe('c0/probe-exec', async () => {
  const files = {
    'probes/out.mjs': OUT,
    'probes/slow.cjs': SLOW,
    ...rowFile(fixtureRow('FW-C-911', { probe: 'node probes/out.mjs' })),
    ...rowFile(fixtureRow('FW-C-912', { probe: 'node probes/slow.cjs' })),
    ...rowFile(fixtureRow('FW-C-913', { probe: 'node probes/out.mjs' })),
    ...rowFile(fixtureRow('FW-C-914', { probe: 'node probes/out.mjs' })),
  };
  files['probes/MANIFEST.sha256'] = `${sha256(OUT)}  probes/out.mjs\n${sha256(SLOW)}  probes/slow.cjs\n`;
  const proj = projectFromFiles(files);
  const home = pipelineHome('pexec');
  const o = { home, cwd: proj.work };
  const sync = fw(['ledger', 'sync', '--json'], o);
  check(sync.status === 0, `fw ledger sync exited ${sync.status}: ${sync.stdout.slice(0, 200)}`);

  // The result event.
  const ok = fwJson(['ledger', 'retest', 'FW-C-911'], o);
  check(ok.status === 0, `fw ledger retest FW-C-911 exited ${ok.status}`);
  let db = await openDbReadonly(home);
  const p = lastProbeEvent(db, 'FW-C-911');
  check(p, 'no ledger.probe_executed event recorded for FW-C-911');
  check(/tail-marker-42/.test(p.output_tail ?? ''), 'the result event does not carry the stdout tail');
  check(p.exit_code === 1, `the result event carries exit_code ${p.exit_code}, want 1`);
  check(Number.isFinite(p.duration_ms) && p.duration_ms >= 0, 'the result event does not carry duration_ms');
  const specs = db.prepare('SELECT probe_spec FROM ledger_rows').all().map((r) => JSON.parse(r.probe_spec));
  check(
    specs.every((s) => Number.isFinite(s.command?.timeout_s) && s.command.timeout_s > 0),
    'a stored probe has no timeout (probe_spec.command.timeout_s)',
  );
  db.close();

  // Timeout: runRowProbe with a 2 s limit, in a child that holds the writer as the CLI does.
  const script = join(home, 'slow-probe.mts');
  writeFileSync(
    script,
    `import { join } from 'node:path';
import { openStore } from ${JSON.stringify(join(root, 'packages/eventlog/src/index.ts'))};
import { runRowProbe } from ${JSON.stringify(join(root, 'packages/ledger/src/index.ts'))};
const home = ${JSON.stringify(home)};
const s = openStore({ path: ${JSON.stringify(dbPath(home))}, lockPath: join(home, 'fwd.lock') });
const r = await runRowProbe(s.writer!, 'FW-C-912', { repoDir: ${JSON.stringify(proj.work)}, target: 'branch', timeoutMs: 2000 });
s.close();
console.log(JSON.stringify(r));
`,
  );
  const started = Date.now();
  const slow = spawnSync(TSX, [script], { encoding: 'utf8', timeout: 60000 });
  const ms = Date.now() - started;
  check(slow.status === 0, `runRowProbe on the slow probe failed: ${(slow.stderr || slow.stdout).split('\n')[0]}`);
  check(ms < 20000, `a probe over its 2 s limit ran for ${ms} ms`);
  const res = JSON.parse(slow.stdout.trim().split('\n').pop());
  check(res.status === 'fail' && res.probe?.timed_out === true, `the timed-out probe returned ${res.status}/${res.probe?.timed_out}`);
  const left = pidsWithMarker(marker);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  check(left.length === 0, `a process started by the timed-out probe is still running: ${left.join(', ')}`);
  db = await openDbReadonly(home);
  const t = lastProbeEvent(db, 'FW-C-912');
  check(t?.status === 'fail' && t?.timed_out === true, 'the timed-out run is not recorded as fail with timed_out');
  const last = db.prepare("SELECT last_probe_status FROM ledger_rows WHERE id = 'lr_FWC912'").get();
  check(last?.last_probe_status === 'fail', `the row records last_probe_status ${last?.last_probe_status}, want fail`);
  db.close();

  // Tamper a): the stored definition is changed behind the ledger's back.
  const attacker = await openDbAsAttacker(home);
  for (const tr of attacker.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ledger_rows'").all()) {
    attacker.exec(`DROP TRIGGER "${tr.name}"`);
  }
  const spec = JSON.parse(attacker.prepare("SELECT probe_spec FROM ledger_rows WHERE id = 'lr_FWC913'").get().probe_spec);
  spec.command.argv = ['true'];
  attacker.prepare("UPDATE ledger_rows SET probe_spec = ? WHERE id = 'lr_FWC913'").run(JSON.stringify(spec));
  attacker.close();
  db = await openDbReadonly(home);
  const runsBefore = count(db, "SELECT count(*) FROM events WHERE type = 'ledger.probe_executed'");
  db.close();
  const tampered = fw(['ledger', 'retest', 'FW-C-913', '--json'], o);
  check(tampered.status !== 0, 'a probe whose stored definition no longer matches its hash was run');
  check(/tamper_detected/.test(tampered.stdout + tampered.stderr), 'the stored-definition refusal does not say tamper_detected');
  db = await openDbReadonly(home);
  check(count(db, "SELECT count(*) FROM events WHERE type = 'ledger.probe_executed'") === runsBefore, 'the tampered probe was executed');
  check(count(db, "SELECT count(*) FROM events WHERE type = 'audit.finding_raised' AND payload LIKE '%probe_tamper%'") >= 1, 'no audit.finding_raised for the tampered definition');
  check(rowStatusOf(db, 'FW-C-913') === 'open', 'the tampered row moved');
  db.close();

  // Tamper b): the probe file no longer matches probes/MANIFEST.sha256.
  appendFileSync(join(proj.work, 'probes/out.mjs'), '// edited after the manifest\n');
  const edited = fw(['ledger', 'retest', 'FW-C-914', '--json'], o);
  check(
    /tamper_detected/.test(edited.stdout + edited.stderr),
    `a probe file that differs from probes/MANIFEST.sha256 was not refused with tamper_detected (exit ${edited.status})`,
  );
  check(edited.status !== 0, 'a probe file that differs from probes/MANIFEST.sha256 was run');
});
