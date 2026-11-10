// Probe c1/daemon-lifecycle (WS-P1-001; backlog verify_probe kernel/daemon-lifecycle).
// Surfaces: the daemon fwd (packages/daemon/src/bin.ts, started as one node process), the fw CLI,
// GET /v1/status (docs/api/LOCAL-API-V1.md, the health figure is `daemon: "up"`) with the CLI token
// fwd prints ("CLI token file: <path>"), the process table (fwd's own listening sockets: Linux /proc, lsof elsewhere), and the database
// at $FW_HOME/db/fw.sqlite read with node:sqlite read-only.
// Acceptance (WS-P1-001):
//   1. the daemon starts, reports healthy, and stops cleanly on SIGTERM with in-flight runs recorded
//      as interrupted
//   2. the health endpoint binds to loopback only (verified by a port scan of this host's own
//      addresses and by every listening socket fwd owns)
//   3. `fw status` works against the daemon and falls back to a direct (read-only) database read
//      when it is down
// How each line is read (see probes/c1/README.md, "Decisions for the Owner"):
//   - The transport between fw and fwd is not probed. The row says unix socket; fwd serves loopback
//     HTTP today. The probe starts fwd on a free port it picks and gives fw FW_HOME and FW_PORT, so a
//     socket under FW_HOME, a discovery file or FW_PORT all satisfy it.
//   - "In-flight run" means a run fwd is executing: with fwd up, `fw run start` hands the run to the
//     daemon (core_adaptation: fwd hosts the pipeline, the CLI is its client). The fake vendor's
//     hang scenario keeps it in flight.
//   - "Recorded as interrupted": schema.core.sql has no `interrupted` run status. The probe wants,
//     before any restart: the run ended (failed or killed, failure_class killed, ended_at set), one
//     terminal run event whose payload says "interrupted", its lease no longer active, its vendor
//     process group gone, and system.stopped with clean: true after that event.
//   - "Falls back to direct DB read": with fwd down, `fw status --json` exits 0, says the daemon is
//     not up, reports the event chain head (chain.head_seq, the GET /v1/status field) equal to the
//     database, and leaves the database file byte-identical.
// Today `fw status` does not exist, and `fw run start` refuses while fwd holds the writer (exit 4).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  CLI_BIN,
  check,
  DAEMON_BIN,
  dbPath,
  fixtureProject,
  fw,
  groupAlive,
  isLoopbackAddress,
  killAndWait,
  listeningTcp,
  missing,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const ROW = 'FW-C-961';
const kids = [];

function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function httpGet(port, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => ok({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    req.end();
  });
}

/** Tries a TCP connect; resolves true when something accepted the connection. */
function accepts(host, port) {
  return new Promise((ok) => {
    const s = createConnection({ host, port, timeout: 1500 });
    s.once('connect', () => {
      s.destroy();
      ok(true);
    });
    s.once('timeout', () => {
      s.destroy();
      ok(false);
    });
    s.once('error', () => ok(false));
  });
}

async function startFwd(home, port, env) {
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { ...env, FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  const startedAt = /fwd (\S+) listening on/.exec(d.output())?.[1];
  return { d, token: readFileSync(tokenPath, 'utf8').trim(), startedAt };
}

/** SIGTERM, then the exit code and how long the stop took (fails after timeoutMs). */
async function sigterm(child, timeoutMs) {
  const t0 = Date.now();
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  process.kill(child.pid, 'SIGTERM');
  const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
  check(res, `fwd did not exit within ${timeoutMs} ms of SIGTERM; output: ${child.output().trim().slice(-300)}`);
  return { ...res, ms: Date.now() - t0 };
}

/** Every value under a key named k anywhere in a JSON document. */
function valuesOf(doc, k, out = []) {
  if (doc && typeof doc === 'object') {
    for (const [key, v] of Object.entries(doc)) {
      if (key === k) out.push(v);
      valuesOf(v, k, out);
    }
  }
  return out;
}

const fileHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

await probe('c1/daemon-lifecycle', async () => {
  const proj = fixtureProject({ rowId: ROW, scenario: 'hang' });
  const home = pipelineHome('c1-daemon');
  const env = pipelineEnv();
  check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work, env }).status === 0, 'fw ledger sync failed on the fixture project');

  try {
    // ---- line 1 (start, healthy, clean SIGTERM) and line 2 (loopback only) --------------------
    const port1 = await freePort();
    const a = await startFwd(home, port1, env);
    const health = await httpGet(port1, '/v1/status', a.token);
    check(health.status === 200, `GET /v1/status with the CLI token answered ${health.status}: ${health.body.slice(0, 200)}`);
    const st = JSON.parse(health.body);
    check((st.data ?? st).daemon === 'up', `GET /v1/status does not report daemon "up": ${health.body.slice(0, 200)}`);

    const socks = listeningTcp(a.d.pid);
    check(socks.some((s) => s.port === port1), `fwd (pid ${a.d.pid}) owns no listening socket on its port ${port1}`);
    for (const s of socks) {
      check(isLoopbackAddress(s.address), `fwd listens on a non-loopback address (${s.address}:${s.port})`);
    }
    for (const addrs of Object.values(networkInterfaces())) {
      for (const n of addrs ?? []) {
        if (n.internal || n.address.startsWith('fe80')) continue;
        check(!(await accepts(n.address, port1)), `fwd's port ${port1} accepts connections on ${n.address} (not loopback)`);
      }
    }
    const any = spawnTs(DAEMON_BIN, ['--home', home, '--port', '0', '--host', '0.0.0.0'], { env: { ...env, FW_HOME: home } });
    kids.push(any);
    await waitFor(() => any.exitCode !== null, { timeoutMs: 30000, what: 'fwd --host 0.0.0.0 to exit' });
    check(any.exitCode !== 0, 'fwd --host 0.0.0.0 was accepted');

    const stop1 = await sigterm(a.d, 15000);
    check(stop1.code === 0, `fwd exited ${stop1.code ?? stop1.signal} on SIGTERM with nothing in flight, want 0`);
    let db = await openDbReadonly(home);
    const stopped = db.prepare("SELECT payload FROM events WHERE type = 'system.stopped' ORDER BY seq DESC").get();
    db.close();
    check(stopped && JSON.parse(stopped.payload).clean === true, 'no system.stopped {clean: true} after SIGTERM');

    // ---- line 3 (fw status against the daemon) ------------------------------------------------
    const port2 = await freePort();
    const b = await startFwd(home, port2, env);
    const cliEnv = { ...env, FW_PORT: String(port2) };
    const up = fw(['status', '--json'], { home, cwd: proj.work, env: cliEnv });
    if (up.status === 2 && /unknown command|usage/i.test(up.stdout + up.stderr)) {
      missing(`fw status is not a command (exit 2: ${(up.stdout + up.stderr).trim().split('\n')[0].slice(0, 160)})`);
    }
    check(up.status === 0, `fw status --json with fwd up exited ${up.status}: ${(up.stdout + up.stderr).slice(0, 200)}`);
    const upDoc = JSON.parse(up.stdout);
    check(valuesOf(upDoc, 'daemon').includes('up'), `fw status with fwd up does not report daemon "up": ${up.stdout.slice(0, 200)}`);
    check(
      JSON.stringify(upDoc).includes(b.startedAt),
      `fw status with fwd up does not carry the daemon's started_at (${b.startedAt}), so it did not ask the daemon`,
    );

    // ---- line 1 (an in-flight run is recorded as interrupted on SIGTERM) ----------------------
    const cli = spawnTs(
      CLI_BIN,
      ['run', 'start', ROW, '--adapter', 'fake', '--scenario', 'hang', '--max-wall-clock-s', '600', '--json'],
      { cwd: proj.work, env: { ...cliEnv, FW_HOME: home } },
    );
    kids.push(cli);
    const started = await waitFor(
      async () => {
        if (cli.exitCode !== null && cli.exitCode !== 0) {
          return { refused: cli.exitCode };
        }
        try {
          const d = await openDbReadonly(home);
          const e = d.prepare("SELECT run_id, seq, payload FROM events WHERE type = 'run.started' ORDER BY seq DESC").get();
          d.close();
          return e;
        } catch {
          return null;
        }
      },
      { timeoutMs: 60000, what: 'run.started of the hanging run started through fwd' },
    );
    check(
      !started.refused,
      `fw run start with fwd up exited ${started.refused} (the daemon does not host runs): ${cli.output().trim().slice(0, 200)}`,
    );
    const runId = started.run_id;
    const pgid = JSON.parse(started.payload).vendor_pgid;
    check(Number.isInteger(pgid) && groupAlive(pgid), 'the hanging vendor is not running under fwd');

    const stop2 = await sigterm(b.d, 30000);
    check(stop2.code === 0, `fwd exited ${stop2.code ?? stop2.signal} on SIGTERM with a run in flight, want 0`);
    await waitFor(() => !groupAlive(pgid), { timeoutMs: 5000, what: "the interrupted run's vendor process group to be gone" });
    db = await openDbReadonly(home);
    const run = db.prepare('SELECT status, failure_class, ended_at FROM runs WHERE id = ?').get(runId);
    check(
      ['failed', 'killed'].includes(run.status) && run.failure_class === 'killed' && run.ended_at,
      `after SIGTERM the in-flight run is ${run.status}/${run.failure_class} (ended_at ${run.ended_at}), want failed or killed, failure_class killed, ended`,
    );
    const ends = db
      .prepare("SELECT seq, payload FROM events WHERE run_id = ? AND type IN ('run.failed','run.killed') ORDER BY seq")
      .all(runId);
    check(ends.length === 1, `${ends.length} terminal events for the interrupted run, want 1`);
    check(/interrupt/i.test(ends[0].payload), `the terminal event does not record the run as interrupted: ${ends[0].payload.slice(0, 200)}`);
    const live = db.prepare("SELECT count(*) AS n FROM leases WHERE run_id = ? AND status = 'active'").get(runId).n;
    check(live === 0, "the interrupted run's lease is still active after SIGTERM");
    const last = db.prepare("SELECT seq, payload FROM events WHERE type = 'system.stopped' ORDER BY seq DESC").get();
    check(
      last && last.seq > ends[0].seq && JSON.parse(last.payload).clean === true,
      'no system.stopped {clean: true} after the interrupted run was recorded',
    );
    const headSeq = db.prepare('SELECT max(seq) AS s FROM events').get().s;
    db.close();

    // ---- line 3 (fw status falls back to a read-only database read) --------------------------
    const before = fileHash(dbPath(home));
    const down = fw(['status', '--json'], { home, cwd: proj.work, env: cliEnv });
    check(down.status === 0, `fw status --json with fwd down exited ${down.status}: ${(down.stdout + down.stderr).slice(0, 200)}`);
    const downDoc = JSON.parse(down.stdout);
    const daemonVals = valuesOf(downDoc, 'daemon');
    check(daemonVals.length > 0 && !daemonVals.includes('up'), `fw status with fwd down does not say the daemon is down: ${down.stdout.slice(0, 200)}`);
    check(
      valuesOf(downDoc, 'head_seq').includes(headSeq),
      `fw status with fwd down does not report chain.head_seq ${headSeq} from the database: ${down.stdout.slice(0, 300)}`,
    );
    check(fileHash(dbPath(home)) === before, 'fw status with fwd down changed the database (the fallback must be read-only)');

    // The writer lock was released by the clean stop: a new fwd starts on the same home.
    const port3 = await freePort();
    const c = await startFwd(home, port3, env);
    await killAndWait(c.d);
  } finally {
    for (const k of kids) {
      try {
        process.kill(k.pid, 'SIGKILL');
      } catch {}
    }
  }
});
