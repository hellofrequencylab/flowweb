// Probe c0/probe-exec (WS-P0-019; backlog verify_probe kernel/probe-exec).
// Surface: `fw ledger probe <ID> --json` (runs the row's verify_probe now and records the result)
// in a fixture project with a probes/MANIFEST.sha256; FW_PROBE_TIMEOUT_S shortens the default limit.
// Acceptance:
//   - a probe exceeding its timeout is killed and recorded as fail
//   - a modified probe file is refused with tamper_detected (and nothing is executed)
//   - the result event (ledger.probe_executed) carries the stdout tail, exit code and duration
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  count,
  fixtureRow,
  freshHome,
  fw,
  fwJson,
  openDbReadonly,
  probe,
  projectFromFiles,
  rowFile,
  sha256,

} from './_lib.mjs';

const PASS = "console.log('probe-exec fixture output line');\nconsole.log('tail-marker-42');\n";
const SLOW = 'setTimeout(() => {}, 300000);\n';

await probe('c0/probe-exec', async () => {
  const files = {
    'probes/pass.mjs': PASS,
    'probes/slow.mjs': SLOW,
    ...rowFile(fixtureRow('FW-C-911', { probe: 'node probes/pass.mjs' })),
    ...rowFile(fixtureRow('FW-C-912', { probe: 'node probes/slow.mjs' })),
  };
  files['probes/MANIFEST.sha256'] = `${sha256(PASS)}  probes/pass.mjs\n${sha256(SLOW)}  probes/slow.mjs\n`;
  const proj = projectFromFiles(files);
  const home = freshHome('pexec');
  const env = { FW_PROBE_TIMEOUT_S: '3' };
  const sync = fw(['ledger', 'sync', '--json'], { home, cwd: proj.work, env });
  check(sync.status === 0, `fw ledger sync exited ${sync.status}: ${sync.stderr.trim().split('\n')[0]}`);

  const ok = fwJson(['ledger', 'probe', 'FW-C-911'], { home, cwd: proj.work, env });
  check(ok.status === 0, `fw ledger probe FW-C-911 exited ${ok.status}`);
  let db = await openDbReadonly(home);
  const ev = db.prepare("SELECT payload FROM events WHERE type = 'ledger.probe_executed' ORDER BY seq DESC LIMIT 1").get();
  check(ev, 'no ledger.probe_executed event recorded');
  const p = JSON.parse(ev.payload);
  const flat = JSON.stringify(p);
  check(/tail-marker-42/.test(flat), 'the result event does not carry the stdout tail');
  check(/"exit_code":0/.test(flat), 'the result event does not carry exit_code 0');
  check(/"duration_ms":\d+|"duration_s":[\d.]+/.test(flat), 'the result event does not carry a duration (duration_ms or duration_s)');
  db.close();

  const started = Date.now();
  const slow = fw(['ledger', 'probe', 'FW-C-912', '--json'], { home, cwd: proj.work, env, timeoutMs: 60000 });
  const ms = Date.now() - started;
  check(ms < 20000, `a probe over its 3 s limit ran for ${ms} ms`);
  check(slow.status !== 0, 'a timed-out probe was reported as success');
  db = await openDbReadonly(home);
  const t = db.prepare("SELECT payload FROM events WHERE type = 'ledger.probe_executed' ORDER BY seq DESC LIMIT 1").get();
  check(/FW-C-912|timeout|timed_out/i.test(t?.payload ?? ''), 'the timed-out run was not recorded');
  const row = JSON.stringify(db.prepare('SELECT last_probe_status FROM ledger_rows').all());
  check(/"fail"/.test(row), 'the timed-out probe is not recorded as fail on the row');
  const before = count(db, "SELECT count(*) FROM events WHERE type = 'ledger.probe_executed'");
  db.close();

  appendFileSync(join(proj.work, 'probes/pass.mjs'), 'process.exit(0);\n');
  const tampered = fw(['ledger', 'probe', 'FW-C-911', '--json'], { home, cwd: proj.work, env });
  check(tampered.status !== 0, 'a probe file that differs from probes/MANIFEST.sha256 was run');
  check(/tamper_detected/.test(tampered.stdout + tampered.stderr), 'the refusal does not say tamper_detected');
  db = await openDbReadonly(home);
  const after = count(db, "SELECT count(*) FROM events WHERE type = 'ledger.probe_executed'");
  const tamperEv = db
    .prepare('SELECT type, payload FROM events ORDER BY seq DESC LIMIT 5')
    .all()
    .some((e) => /tamper/i.test(e.payload) || /tamper/i.test(e.type));
  db.close();
  check(after === before || tamperEv, 'a tampered probe produced a probe result without a tamper record');
  check(tamperEv, 'no event records the tamper_detected refusal');
});
