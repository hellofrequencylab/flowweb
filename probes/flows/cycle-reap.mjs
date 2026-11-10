// Probe for FW-C-045 (a crash never leaves a flow cycle's vendor running): `pnpm probe flows/cycle-reap`.
// Tier 0. Linux only (it finds the vendor's processes by their working directory under /proc).
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hang (the
// vendor ignores SIGTERM and starts a background grandchild, so only a group SIGKILL ends it), the
// Owner controls under /v1/supervisor with the CLI token fwd prints, the cycle folder
// $FW_HOME/flows/<key>/cycles/<fire>/, and the database read-only.
//
// Proves, in order:
//   1. A cycle that is running when fwd dies (SIGKILL, no clean stop) leaves its vendor running: the
//      premise. fwd's clean stop already kills it (FW-C-038); a crash does not.
//   2. When fwd starts again on the same home, every process of that cycle's vendor is gone within
//      15 seconds, grandchild included.
//   3. The interrupted cycle ends in exactly one run report for its fire, outcome failed, with a
//      reason that starts "orphaned", and a second restart writes no second report.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join, sep } from 'node:path';
import {
  check,
  DAEMON_BIN,
  freshHome,
  killAndWait,
  missing,
  openDbReadonly,
  probe,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/cycle-reap';
const KEY = 'neighborhood-activation';
const kids = [];

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function http(port, method, path, token) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 10000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => ok({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    req.end();
  });
}

/** Live pids whose working directory is dir or inside it. */
function pidsIn(dir) {
  const out = [];
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const cwd = readlinkSync(`/proc/${n}/cwd`);
      if (cwd === dir || cwd.startsWith(dir + sep)) out.push(Number(n));
    } catch {}
  }
  return out;
}

async function startFwd(home) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hang' };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function reportsFor(home, fireId) {
  const db = await openDbReadonly(home);
  try {
    return db
      .prepare("SELECT body FROM status_reports WHERE kind = 'run'")
      .all()
      .map((r) => JSON.parse(r.body))
      .filter((b) => b.fire_id === fireId);
  } finally {
    db.close();
  }
}

const home = freshHome('cycle-reap');
const cycles = join(home, 'flows', KEY, 'cycles');

await probe(NAME, async () => {
  try {
    readdirSync('/proc');
  } catch {
    missing('this probe needs Linux /proc to find the vendor processes');
  }
  try {
    // ---- 1. a crash mid-cycle leaves the vendor running ----------------------------------------------
    const a = await startFwd(home);
    const en = await http(a.port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, a.token);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}`);
    const run = JSON.parse((await http(a.port, 'POST', `/v1/supervisor/flows/${KEY}/run`, a.token)).body)?.data;
    check(run?.outcome === 'fired', `running ${KEY}: ${JSON.stringify(run)}, want fired`);
    const dir = join(cycles, run.fire_id.replace(/[^A-Za-z0-9_-]/g, '_'));
    // The leader and its background grandchild.
    await waitFor(() => pidsIn(dir).length >= 2, { timeoutMs: 20000, everyMs: 200, what: "the cycle's vendor to start" });
    await killAndWait(a.d, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    const left = pidsIn(dir);
    check(left.length >= 1, 'killing fwd also ended the vendor; the premise needs it left behind');

    // ---- 2. the next start kills every process of that cycle -------------------------------------
    const b = await startFwd(home);
    let still = left;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && still.length > 0) {
      await new Promise((r) => setTimeout(r, 250));
      still = pidsIn(dir);
    }
    check(still.length === 0, `15 s after fwd restarted, the crashed cycle's vendor is still running (pids ${still.join(', ')})`);

    // ---- 3. one failed report for the interrupted fire, and only one ------------------------------
    let reps = [];
    await waitFor(
      async () => {
        reps = await reportsFor(home, run.fire_id);
        return reps.length > 0;
      },
      { timeoutMs: 10000, everyMs: 250, what: 'a run report for the interrupted cycle' },
    );
    check(
      reps.length === 1 && reps[0].outcome === 'failed' && String(reps[0].reason ?? '').startsWith('orphaned'),
      `run reports for the interrupted fire: ${JSON.stringify(reps).slice(0, 300)}, want one failed, reason "orphaned…"`,
    );
    await killAndWait(b.d, 'SIGTERM');
    const c = await startFwd(home);
    await new Promise((r) => setTimeout(r, 1500));
    reps = await reportsFor(home, run.fire_id);
    check(reps.length === 1, `after a second restart the interrupted fire has ${reps.length} run reports, want 1`);
    await killAndWait(c.d, 'SIGTERM');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
    // Never leave a hung vendor behind on the machine running the probe.
    for (const pid of pidsIn(cycles)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
});
