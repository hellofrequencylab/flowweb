// Probe for FW-C-159 (the weekly review runs when it is due, not only after fwd has stayed up a week):
// `pnpm probe flows/review-due`. Tier 0.
// probe-timeout-s: 180
// Surfaces: the daemon fwd on a fresh FW_HOME, started with no FW_REVIEW_EVERY_MS (the default week), the
// hunt route under /v1/flows/neighborhood-activation with the CLI token fwd prints, and the file
// $FW_HOME/flows/neighborhood-activation/review.json.
// The surface this probe expects:
//   Soon after it starts (within 20 s), fwd runs the weekly review of FW-C-056 by itself when the flow has
//   at least one hunt and review.json is missing or its `at` is a week old or more. A review younger than
//   that is left exactly as it is, so shifts waiting for the Owner are not replaced by a restart.
//
// Proves, in order:
//   1. With a hunt and no review.json, a freshly started fwd writes review.json with no call.
//   2. With a review 8 days old, a restart replaces it with a new one.
//   3. With a review 1 day old, a restart leaves the file untouched.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/review-due';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}`;
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

function http(port, method, path, token, body) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 10000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => ok({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return undefined;
  }
};

async function startFwd(home, extra = {}) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_OUTCOMES_PULL_EVERY_MS: '86400000', ...extra };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

await probe(NAME, async () => {
  const home = freshHome('review-due');
  try {
    const reviewFile = join(home, 'flows', KEY, 'review.json');
    const readAt = () => (existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')).at : null);
    let f = await startFwd(home);
    const r = await http(f.port, 'POST', `${BASE}/hunts`, f.token, { name: 'Sound baths', looking_for: 'Sound baths', region: 'north-county-sd', max_sends: 10 });
    check(r.status === 201, `saving a hunt answered ${r.status}: ${r.body.slice(0, 200)}`);
    await killAndWait(f.d, 'SIGKILL');
    rmSync(reviewFile, { force: true });

    // ---- 1. no review yet: fwd writes one soon after it starts -------------------------------------------
    f = await startFwd(home);
    try {
      await waitFor(() => readAt() !== null, { timeoutMs: 20000, everyMs: 250, what: 'the first review' });
    } catch {
      missing('fwd started with a hunt and no review.json and wrote none within 20 s (the review only runs on a week-long timer)');
    }
    const first = readAt();
    check(Number.isFinite(Date.parse(first)), `review.json has at ${JSON.stringify(first)}`);
    await killAndWait(f.d, 'SIGKILL');

    // ---- 2. a review 8 days old is replaced ---------------------------------------------------------------
    const old = JSON.parse(readFileSync(reviewFile, 'utf8'));
    const eightDays = new Date(Date.now() - 8 * 86400e3).toISOString();
    writeFileSync(reviewFile, `${JSON.stringify({ ...old, at: eightDays }, null, 2)}\n`);
    f = await startFwd(home);
    await waitFor(() => readAt() !== eightDays, { timeoutMs: 20000, everyMs: 250, what: 'fwd to replace a review 8 days old' });
    check(Date.now() - Date.parse(readAt()) < 60000, `the new review is dated ${readAt()}`);
    await killAndWait(f.d, 'SIGKILL');

    // ---- 3. a review 1 day old is left alone ---------------------------------------------------------------
    const oneDay = new Date(Date.now() - 86400e3).toISOString();
    const kept = `${JSON.stringify({ ...old, at: oneDay, probe_mark: 'kept' }, null, 2)}\n`;
    writeFileSync(reviewFile, kept);
    f = await startFwd(home);
    await new Promise((ok) => setTimeout(ok, 12000));
    check(readFileSync(reviewFile, 'utf8') === kept, 'fwd replaced a review that was only 1 day old');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
