// Probe for FW-C-160 (a crash or reboot cannot keep fwd down because its old pid was given to another
// process): `pnpm probe workstreams/lock-reuse`. Tier 0.
// probe-timeout-s: 180
// Surfaces: the daemon fwd on a fresh FW_HOME and its writer lock file $FW_HOME/fwd.lock, which holds
// "<pid> <nonce>".
// The surface this probe expects:
//   fwd takes over a lock whose pid is alive but belongs to a process that started well after the lock
//   file was last written: the fwd that wrote it is gone and the system reused its pid. It still refuses,
//   with "another fwd is already running", when the lock belongs to a running fwd, and when the pid in the
//   lock is alive and started before the lock was written (it may be the writer, so refusing is safe).
//
// Proves, in order:
//   1. A lock written an hour ago naming a live process that started just now does not stop fwd: it starts.
//   2. A second fwd on the same home is still refused while the first runs.
//   3. A lock written now naming a live process that started earlier is still treated as held.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnBg, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'workstreams/lock-reuse';
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

async function fwd(home) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home, FW_VENDOR: 'fake' } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 40000, what: 'fwd to listen or exit' });
  return d;
}

/** A live process that is not fwd and started just now. */
function bystander() {
  const c = spawnBg(process.execPath, ['-e', 'setTimeout(() => {}, 120000)']);
  kids.push(c);
  return c;
}

await probe(NAME, async () => {
  try {
    // ---- 1. an old lock whose pid was reused does not stop fwd ---------------------------------------------
    const home = freshHome('lock-reuse');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const lock = join(home, 'fwd.lock');
    const other = bystander();
    await new Promise((ok) => setTimeout(ok, 1500));
    writeFileSync(lock, `${other.pid} 00112233aabbccdd\n`, { mode: 0o600 });
    const hourAgo = new Date(Date.now() - 3600e3);
    utimesSync(lock, hourAgo, hourAgo);
    const first = await fwd(home);
    if (first.exitCode !== null && /already running/.test(first.output()))
      missing(`fwd refused to start over a lock whose pid ${other.pid} belongs to a process started after the lock was written`);
    check(first.exitCode === null, `fwd did not start: ${first.output().trim().split('\n')[0]}`);

    // ---- 2. a running fwd still keeps a second one out ------------------------------------------------------
    const second = await fwd(home);
    await waitFor(() => second.exitCode !== null, { timeoutMs: 20000, what: 'the second fwd to exit' });
    check(second.exitCode !== 0 && /already running/.test(second.output()), `a second fwd on the same home was not refused: ${second.output().trim().split('\n')[0]}`);
    check(first.exitCode === null, 'the first fwd stopped when a second one tried to start');
    await killAndWait(first, 'SIGKILL');

    // ---- 3. a pid that may be the writer is still treated as held ------------------------------------------
    const home3 = freshHome('lock-reuse-held');
    mkdirSync(home3, { recursive: true, mode: 0o700 });
    const elder = bystander();
    await new Promise((ok) => setTimeout(ok, 1500));
    writeFileSync(join(home3, 'fwd.lock'), `${elder.pid} 00112233aabbccdd\n`, { mode: 0o600 });
    const third = await fwd(home3);
    await waitFor(() => third.exitCode !== null || /listening on/.test(third.output()), { timeoutMs: 20000, what: 'the third fwd to answer' });
    check(third.exitCode !== null && third.exitCode !== 0 && /already running/.test(third.output()), 'fwd took over a lock whose live pid started before the lock was written');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
