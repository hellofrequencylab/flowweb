// Probe for FW-C-056 (each week the flow scores its hunts and shifts effort toward what works, as far as
// the dial allows): `pnpm probe flows/review`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME, the hunt routes and the review routes under
// /v1/flows/neighborhood-activation with the CLI token fwd prints, the Supervisor enable and dial routes,
// and the flow's files under $FW_HOME/flows/neighborhood-activation/ (drafts/, outcomes.json, hunts.json).
// The surface this probe expects:
//   POST /v1/flows/neighborhood-activation/review/run   -> 200 { data: review }   (CLI token)
//   GET  /v1/flows/neighborhood-activation/review       -> 200 { data: review }   (the last one written)
//   POST /v1/flows/neighborhood-activation/review/shifts/{id}/apply | dismiss -> 200 { data: shift }
//        -> 404 for an unknown shift, 409 when it is no longer proposed
//   review = { at, scorecard: { hunts: [{ hunt_id, name, drafted, sent, replied, declined, leads, members,
//              hosts, paid, responded, rate }] }, shifts: [{ id, kind: 'pause' | 'max_sends', hunt_id, from,
//              to, why, status: 'proposed' | 'applied' | 'dismissed' }], learnings: [string] }
//   A draft counts as sent when it has sent_at; it responded when it has replied_at or its tag has a
//   lead, member or host in outcomes.json. A hunt with 15 or more sent and none responded gets a pause
//   shift. max_sends shifts move the enabled hunts' sends toward the ones that respond, and never raise
//   the enabled hunts' total max_sends. Shifts wait for the Owner at Draft and Copilot; at confirmed
//   Autopilot the review applies them itself, writing hunts.json. The flow's weekly invite cap, its
//   regions and its policy are never changed by a review. fwd also runs the review on its own every
//   FW_REVIEW_EVERY_MS (default a week).
//
// Proves, in order:
//   1. Running the review needs the CLI token (401 without).
//   2. The scorecard joins drafts and outcomes per hunt: hunt A 12 sent, 6 replied, 2 members; hunt B
//      16 sent, none responded.
//   3. At Draft, B gets a proposed pause, no shift raises the total max_sends, learnings name A, and
//      hunts.json is unchanged.
//   4. Applying the pause turns B off in hunts.json; the shift reads applied; applying again answers 409;
//      an unknown shift answers 404.
//   5. At confirmed Autopilot a fresh review applies its shifts itself, and the weekly invite cap is
//      unchanged.
//   6. fwd runs the review on its own: with FW_REVIEW_EVERY_MS short, review.json appears with no call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/review';
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

/** Writes n sent drafts for a hunt; the first `replied` have replied_at. Answers their tags. */
function seedDrafts(dir, huntId, n, replied) {
  mkdirSync(dir, { recursive: true });
  const tags = [];
  for (let i = 0; i < n; i++) {
    const id = `${huntId}-${String(i).padStart(12, '0')}`;
    tags.push(id);
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
  return tags;
}

await probe(NAME, async () => {
  const home = freshHome('review');
  try {
    const flowDir = join(home, 'flows', KEY);
    let f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);
    check((await api('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, `enabling ${KEY} failed`);
    const mk = async (name) => {
      const r = await api('POST', `${BASE}/hunts`, { name, looking_for: name, region: 'north-county-sd', max_sends: 10 });
      check(r.status === 201, `saving hunt ${name} answered ${r.status}: ${r.body.slice(0, 200)}`);
      return json(r).data;
    };
    const A = await mk('Sound baths');
    const B = await mk('Chess clubs');
    const tagsA = seedDrafts(join(flowDir, 'drafts'), A.id, 12, 6);
    seedDrafts(join(flowDir, 'drafts'), B.id, 16, 0);
    writeFileSync(
      join(flowDir, 'outcomes.json'),
      JSON.stringify({
        pulled_at: '2026-11-09T00:00:00.000Z',
        outcomes: [
          { campaign: A.id, content: tagsA[0], medium: 'email', src: 'hunt', leads: 1, members: 1, hosts: 1, paid: 0 },
          { campaign: A.id, content: tagsA[7], medium: 'email', src: 'hunt', leads: 1, members: 1, hosts: 0, paid: 0 },
        ],
        regions: [],
      }),
    );
    const capBefore = JSON.stringify(json(await api('GET', `${BASE}/config`))?.data?.leads ?? null);
    const huntsFile = join(flowDir, 'hunts.json');
    const huntsBefore = readFileSync(huntsFile, 'utf8');

    // ---- 1. the token is needed ---------------------------------------------------------------------
    const anon = await http(f.port, 'POST', `${BASE}/review/run`, null);
    if (anon.status === 404 || anon.status === 405) missing(`POST ${BASE}/review/run answered ${anon.status} (no review route)`);
    check(anon.status === 401, `running the review without a token answered ${anon.status}, want 401`);

    // ---- 2. the scorecard ---------------------------------------------------------------------------
    const run = await api('POST', `${BASE}/review/run`);
    check(run.status === 200, `running the review answered ${run.status}: ${run.body.slice(0, 200)}`);
    const rev = json(run).data;
    const card = (id) => rev?.scorecard?.hunts?.find((h) => h.hunt_id === id);
    const a = card(A.id);
    const b = card(B.id);
    check(a?.sent === 12 && a?.replied === 6 && a?.members === 2 && a?.responded >= 6, `hunt A on the scorecard: ${JSON.stringify(a)}`);
    check(b?.sent === 16 && b?.responded === 0, `hunt B on the scorecard: ${JSON.stringify(b)}`);

    // ---- 3. at Draft the shifts wait ----------------------------------------------------------------
    const pause = rev.shifts?.find((s) => s.kind === 'pause' && s.hunt_id === B.id);
    check(pause?.status === 'proposed', `want a proposed pause for hunt B: ${JSON.stringify(rev.shifts)}`);
    const total = (list) => list.filter((h) => h.enabled !== false).reduce((n, h) => n + h.max_sends, 0);
    const proposedMax = rev.shifts.filter((s) => s.kind === 'max_sends').reduce((n, s) => n + (s.to - s.from), 0);
    check(proposedMax <= 0, `the shifts raise the total max_sends by ${proposedMax}`);
    for (const s of rev.shifts) check(s.status === 'proposed', `at Draft a shift is ${s.status}`);
    check(Array.isArray(rev.learnings) && rev.learnings.some((l) => l.includes(A.name)), `learnings do not name ${A.name}: ${JSON.stringify(rev.learnings)}`);
    check(readFileSync(huntsFile, 'utf8') === huntsBefore, 'a review at Draft changed hunts.json');
    const got = json(await api('GET', `${BASE}/review`))?.data;
    check(got?.at === rev.at, 'GET review does not answer the last review');

    // ---- 4. the Owner applies one shift -------------------------------------------------------------
    const ap = await api('POST', `${BASE}/review/shifts/${pause.id}/apply`);
    check(ap.status === 200 && json(ap)?.data?.status === 'applied', `applying the pause answered ${ap.status}: ${ap.body.slice(0, 200)}`);
    const afterApply = JSON.parse(readFileSync(huntsFile, 'utf8')).hunts;
    check(afterApply.find((h) => h.id === B.id)?.enabled === false, 'applying the pause did not turn hunt B off');
    check((await api('POST', `${BASE}/review/shifts/${pause.id}/apply`)).status === 409, 'applying a shift twice did not answer 409');
    check((await api('POST', `${BASE}/review/shifts/shf_nope/apply`)).status === 404, 'an unknown shift did not answer 404');

    // ---- 5. at confirmed Autopilot the review applies itself ---------------------------------------------
    const C = await mk('Book clubs');
    seedDrafts(join(flowDir, 'drafts'), C.id, 15, 0);
    const ask = await api('POST', `/v1/supervisor/flows/${KEY}/dial`, { stop: 'autopilot' });
    const hash = json(ask)?.error?.details?.confirm_hash ?? json(ask)?.error?.confirm_hash;
    check(typeof hash === 'string', `asking for Autopilot answered ${ask.status}: ${ask.body.slice(0, 200)}`);
    check((await api('POST', `/v1/supervisor/flows/${KEY}/dial`, { stop: 'autopilot', confirm: hash })).status === 200, 'confirming Autopilot failed');
    const totalBefore = total(JSON.parse(readFileSync(huntsFile, 'utf8')).hunts);
    const auto = json(await api('POST', `${BASE}/review/run`))?.data;
    const pauseC = auto?.shifts?.find((s) => s.kind === 'pause' && s.hunt_id === C.id);
    check(pauseC?.status === 'applied', `at Autopilot the pause for hunt C is ${pauseC?.status}: ${JSON.stringify(auto?.shifts)}`);
    const huntsAuto = JSON.parse(readFileSync(huntsFile, 'utf8')).hunts;
    check(huntsAuto.find((h) => h.id === C.id)?.enabled === false, 'at Autopilot hunt C was not turned off');
    check(total(huntsAuto) <= totalBefore, `the review raised the total max_sends from ${totalBefore} to ${total(huntsAuto)}`);
    check(JSON.stringify(json(await api('GET', `${BASE}/config`))?.data?.leads ?? null) === capBefore, 'a review changed the weekly invite cap');

    // ---- 6. fwd reviews on its own ---------------------------------------------------------------------
    await killAndWait(f.d, 'SIGKILL');
    const reviewFile = join(flowDir, 'review.json');
    const stamp = existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')).at : null;
    f = await startFwd(home, { FW_REVIEW_EVERY_MS: '1000' });
    await waitFor(
      () => existsSync(reviewFile) && JSON.parse(readFileSync(reviewFile, 'utf8')).at !== stamp,
      { timeoutMs: 20000, everyMs: 250, what: 'fwd to run the review on its own' },
    );
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
