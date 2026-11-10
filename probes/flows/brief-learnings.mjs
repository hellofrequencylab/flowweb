// Probe for FW-C-057 (each cycle starts from what the last weekly review learned): `pnpm probe flows/brief-learnings`.
// Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hunt_leads, the hunt
// and review routes under /v1/flows/neighborhood-activation with the CLI token fwd prints, the Supervisor
// enable route, the run reports in the database (read-only), and the flow's files under
// $FW_HOME/flows/neighborhood-activation/ (drafts/, outcomes.json, review.json, cycles/<fire>/).
// The surface this probe expects:
//   When the flow's last review (review.json, written by the weekly review) has learnings and is at most
//   30 days old, every cycle folder gets learnings.json: { from: <review.at>, learnings: [string] }, the
//   review's learnings unchanged. The cycle's brief tells the agent to read it, as data, and lean toward
//   what works; the agent may not write it. With no review, an empty one, or one older than 30 days, the
//   cycle folder has no learnings.json.
//
// Proves, in order:
//   1. Before any review, a hunt cycle's folder has no learnings.json.
//   2. After a review with learnings, the next cycle's folder has learnings.json naming that review and
//      carrying its learnings.
//   3. Once the review is older than 30 days, the next cycle's folder has no learnings.json again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, openDbReadonly, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/brief-learnings';
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

async function startFwd(home) {
  const port = await freePort();
  const env = {
    FW_HOME: home,
    FW_VENDOR: 'fake',
    FW_FAKE_SCENARIO: 'hunt_leads',
    FW_OUTCOMES_PULL_EVERY_MS: '86400000',
    FW_REVIEW_EVERY_MS: '86400000',
  };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function reports(home) {
  const db = await openDbReadonly(home);
  try {
    return db
      .prepare("SELECT body FROM status_reports WHERE kind = 'run' ORDER BY created_at")
      .all()
      .map((r) => JSON.parse(r.body));
  } finally {
    db.close();
  }
}

/** Writes n sent drafts for a hunt; the first `replied` have replied_at. */
function seedDrafts(dir, huntId, n, replied) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = `${huntId}-${String(i).padStart(12, '0')}`;
    const doc = {
      flow: KEY,
      id,
      hunt_id: huntId,
      tag: id,
      channel: 'frequency',
      send_via: 'email',
      to: `organizer${i}@${huntId}.example.com`,
      subject: 'Hello',
      body: 'Hi',
      status: 'waiting_for_owner',
      created_at: '2026-11-01T00:00:00.000Z',
      sent_at: '2026-11-02T00:00:00.000Z',
      ...(i < replied ? { replied_at: '2026-11-03T00:00:00.000Z' } : {}),
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

await probe(NAME, async () => {
  const home = freshHome('brief-learnings');
  try {
    const flowDir = join(home, 'flows', KEY);
    const f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);
    check((await api('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, `enabling ${KEY} failed`);
    const made = await api('POST', `${BASE}/hunts`, {
      name: 'Sound baths',
      looking_for: 'sound baths',
      region: 'north-county-sd',
      max_sends: 10,
    });
    check(made.status === 201, `saving a hunt answered ${made.status}: ${made.body.slice(0, 200)}`);
    const A = json(made).data;

    /** Runs hunt A once and answers its cycle folder. */
    async function cycle() {
      const run = await api('POST', `${BASE}/hunts/${A.id}/run`);
      check(run.status === 200, `running the hunt answered ${run.status}: ${run.body.slice(0, 200)}`);
      const rd = json(run)?.data;
      check(rd?.outcome === 'fired', `running the hunt: outcome ${rd?.outcome} (${rd?.reason ?? ''}), want fired`);
      await waitFor(async () => (await reports(home)).some((b) => b.fire_id === rd.fire_id), {
        timeoutMs: 30000,
        everyMs: 250,
        what: 'the cycle to write its run report',
      });
      return join(flowDir, 'cycles', rd.fire_id.replace(/[^A-Za-z0-9_-]/g, '_'));
    }

    // ---- 1. no review, no learnings ------------------------------------------------------------------
    const c1 = await cycle();
    check(existsSync(join(c1, 'hunts.json')), `the cycle folder ${c1} has no hunts.json`);
    check(!existsSync(join(c1, 'learnings.json')), 'a cycle before any review has learnings.json');

    // ---- 2. a review with learnings reaches the next cycle -----------------------------------------------
    seedDrafts(join(flowDir, 'drafts'), A.id, 12, 6);
    const run = await api('POST', `${BASE}/review/run`);
    check(run.status === 200, `running the review answered ${run.status}: ${run.body.slice(0, 200)}`);
    const rev = json(run).data;
    check(Array.isArray(rev?.learnings) && rev.learnings.length > 0, `the review has no learnings: ${run.body.slice(0, 300)}`);
    const c2 = await cycle();
    const lf = join(c2, 'learnings.json');
    check(existsSync(lf), 'the cycle after a review has no learnings.json');
    const got = JSON.parse(readFileSync(lf, 'utf8'));
    check(got.from === rev.at, `learnings.json names review ${got.from}, want ${rev.at}`);
    check(
      JSON.stringify(got.learnings) === JSON.stringify(rev.learnings),
      `learnings.json carries ${JSON.stringify(got.learnings)}, want ${JSON.stringify(rev.learnings)}`,
    );

    // ---- 3. a stale review is not carried --------------------------------------------------------------
    const reviewFile = join(flowDir, 'review.json');
    const old = JSON.parse(readFileSync(reviewFile, 'utf8'));
    old.at = new Date(Date.now() - 40 * 86400e3).toISOString();
    writeFileSync(reviewFile, `${JSON.stringify(old, null, 2)}\n`);
    const c3 = await cycle();
    check(!existsSync(join(c3, 'learnings.json')), 'a cycle after a 40-day-old review has learnings.json');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
