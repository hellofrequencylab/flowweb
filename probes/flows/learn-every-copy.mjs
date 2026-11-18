// Probe for FW-C-166 (the outcome pull, the weekly review and What's working cover every copy of the flow):
// `pnpm probe flows/learn-every-copy`. Tier 0.
// probe-timeout-s: 240
// Surfaces: the daemon fwd on a fresh FW_HOME, a stand-in Frequency on 127.0.0.1 named by
// FW_FREQUENCY_URL, the credential file $FW_HOME/creds/crd_frequencyoutcomes (the root home only),
// POST /v1/supervisor/flows/neighborhood-activation/copy with a profile, the base flow's routes under
// /v1/flows/neighborhood-activation (hunts, outcomes/pull, review/run), GET /v1/flows/{key}/review/summary,
// and the copy's files under $FW_HOME/copies/neighborhood-activation--coaches-guides/flows/neighborhood-activation/.
// The surface this probe expects:
//   The base flow and each live copy (Supervisor settings: copy_of the base, not archived) are pulled and
//   reviewed one by one, each from its own hunts and drafts, each writing outcomes.json, pull.json and
//   review.json under its own home. A copy's pull is one more signed POST to
//   <Frequency>/api/webhooks/flowweb-outcomes whose body names { since, flow: <copy key>, tags: [the tags
//   of the copy's drafts] }; of the answer the copy keeps only rows for those tags or its own hunts. The
//   base flow's request still names only since. POST .../outcomes/pull and POST .../review/run on the base
//   flow do the copies too and still answer the base flow's result. Soon after it starts fwd reviews a copy
//   whose review is missing or a week old, as it does the base flow.
//
// Proves, in order:
//   1. A pull asks Frequency about the copy by its key and its drafts' tags, signed, and writes the copy's
//      own pull.json and outcomes.json holding only the copy's row. The base request names only since.
//   2. A review run writes the copy's own review.json scoring the copy's 12 sent drafts (5 replied, 1
//      signed up); two drafts fwd retired because their event passed are not counted as sent.
//   3. GET /v1/flows/<copy>/review/summary answers ready with those totals and the copy's hunt as best.
//   4. The base flow's review counts none of them, and its summary shows nothing sent.
//   5. With the copy's review.json gone, a restarted fwd writes it again by itself within 20 seconds.
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { check, freshHome, missing, probe, waitFor } from '../c0/_lib.mjs';
import { api, freePort, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/learn-every-copy';
const KEY = 'neighborhood-activation';
const COPY = `${KEY}--coaches-guides`;
const SECRET = 'probe-secret-not-real-0123456789abcdef';
const HANDLE = 'crd_frequencyoutcomes';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** A stand-in Frequency: records each signed request and answers one row for the copy and one for another flow. */
async function fakeFrequency(rows) {
  const seen = [];
  const port = await freePort();
  const server = createHttpServer((req, res) => {
    let text = '';
    req.on('data', (d) => {
      text += d;
    });
    req.on('end', () => {
      const ts = String(req.headers['x-flowweb-timestamp'] ?? '');
      const sig = String(req.headers['x-flowweb-signature'] ?? '');
      const want = createHmac('sha256', SECRET).update(`${ts}.${text}`).digest('hex');
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      seen.push({ path: req.url, signed: sig === want, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url !== '/api/webhooks/flowweb-outcomes') return res.end('{"status":"off"}');
      res.end(JSON.stringify({ as_of: new Date().toISOString(), since: body?.since ?? null, outcomes: rows(), regions: [] }));
    });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

function seed(dir, huntId, n, replied, extra = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tags = [];
  for (let i = 0; i < n; i++) {
    const id = `${huntId}-${String(i).padStart(12, '0')}${extra.retired ? 'r' : ''}`;
    tags.push(id);
    const doc = {
      flow: KEY,
      id,
      hunt_id: huntId,
      tag: id,
      channel: 'frequency',
      send_via: 'contact_form',
      contact_url: `https://coach${i}.example.com/contact`,
      source_url: 'https://www.eventbrite.com/e/1',
      angle: 'their-event',
      subject: 'Hello',
      body: 'Hi',
      status: 'waiting_for_owner',
      created_at: '2026-11-01T00:00:00.000Z',
      sent_at: '2026-11-02T00:00:00.000Z',
      ...(i < replied ? { replied_at: '2026-11-03T00:00:00.000Z' } : {}),
      ...extra,
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  }
  return tags;
}

await probe(NAME, async () => {
  const home = realpathSync(freshHome('learn-every-copy'));
  let tags = [];
  const freq = await fakeFrequency(() => [
    { campaign: 'hnt_copy', content: tags[0] ?? 'none', medium: 'email', src: 'hunt', leads: 1, members: 1, hosts: 0, paid: 0 },
    { campaign: 'hnt_someoneelse', content: 'hnt_someoneelse-000000000001', medium: 'email', src: 'hunt', leads: 4, members: 3, hosts: 0, paid: 0 },
  ]);
  const env = { FW_VENDOR: 'fake', FW_FREQUENCY_URL: freq.url, FW_OUTCOMES_PULL_EVERY_MS: '86400000' };
  mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'creds', HANDLE), SECRET, { mode: 0o600 });
  let f = await startFwd(home, { env });
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, body });
    const copyDir = join(home, 'copies', COPY, 'flows', KEY);
    const baseDir = join(home, 'flows', KEY);

    // A base flow with a hunt, and one copy made through the copy route with a profile (its own hunt).
    const bh = await call('POST', `/v1/flows/${KEY}/hunts`, { name: 'Sound baths', looking_for: 'Sound baths', region: 'north-county-sd', max_sends: 10 });
    check(bh.status === 201, `saving the base hunt answered ${bh.status}: ${bh.text.slice(0, 200)}`);
    const made = await call('POST', `/v1/supervisor/flows/${KEY}/copy`, { profile: 'coaches-guides' });
    check(made.status === 200 && made.json?.data?.key === COPY, `making the copy answered ${made.status}: ${made.text.slice(0, 200)}`);
    const hunt = read(join(copyDir, 'hunts.json')).hunts[0];
    check(hunt?.id, "the copy has no starter hunt from its profile");
    // Sent and replied drafts in the copy only; two more that fwd retired because the event passed.
    tags = seed(join(copyDir, 'drafts'), hunt.id, 12, 5);
    seed(join(copyDir, 'drafts'), hunt.id, 2, 0, { retired: 'event_passed', status: 'rejected', sent_at: undefined, held: 'The event has passed.' });

    // ---- 1. the pull asks about the copy and writes the copy's own files -----------------------------------
    freq.seen.length = 0;
    const pull = await call('POST', `/v1/flows/${KEY}/outcomes/pull`);
    check(pull.status === 200, `the pull answered ${pull.status}: ${pull.text.slice(0, 200)}`);
    const pulls = freq.seen.filter((x) => x.path === '/api/webhooks/flowweb-outcomes');
    const mine = pulls.find((x) => x.body?.flow === COPY);
    if (!mine) missing(`no outcomes request named the copy ${COPY} (the pull only covers the base flow)`);
    check(mine.signed, "the copy's request does not carry a signature that verifies");
    check(typeof mine.body.since === 'string', "the copy's request names no since");
    check(Array.isArray(mine.body.tags) && tags.every((t) => mine.body.tags.includes(t)), `the copy's request does not name its drafts' tags: ${JSON.stringify(mine.body.tags)?.slice(0, 200)}`);
    const basePull = pulls.find((x) => x.body && x.body.flow === undefined);
    check(basePull && Object.keys(basePull.body).join(',') === 'since', `the base flow's request changed: ${JSON.stringify(basePull?.body)}`);
    const last = read(join(copyDir, 'pull.json'));
    check(last.ok === true && Number.isFinite(Date.parse(last.at)), `the copy's pull.json: ${JSON.stringify(last)}`);
    const kept = read(join(copyDir, 'outcomes.json')).outcomes;
    check(kept.length === 1 && kept[0].content === tags[0] && kept[0].members === 1, `the copy's outcomes.json rows: ${JSON.stringify(kept)}`);
    check(read(join(baseDir, 'outcomes.json')).outcomes.length === 2, "the base flow's outcomes.json no longer holds every row");

    // ---- 2. a review run scores the copy's own drafts -------------------------------------------------------
    const run = await call('POST', `/v1/flows/${KEY}/review/run`);
    check(run.status === 200, `running the review answered ${run.status}: ${run.text.slice(0, 200)}`);
    if (!existsSync(join(copyDir, 'review.json'))) missing("a review run wrote no review.json under the copy's home");
    const rev = read(join(copyDir, 'review.json'));
    const t = rev.scorecard?.totals;
    check(t?.sent === 12 && t?.replied === 5 && t?.signups === 1, `the copy's review totals: ${JSON.stringify(t)}`);
    const card = rev.scorecard.hunts.find((h) => h.hunt_id === hunt.id);
    check(card?.sent === 12 && card?.replied === 5 && card?.members === 1, `the copy's hunt card: ${JSON.stringify(card)}`);
    check(rev.auto_apply === false && rev.shifts.every((s) => s.status === 'proposed'), 'a copy at Draft had review shifts applied');
    check(rev.learnings.some((l) => l.includes(hunt.name)), `the copy's learnings do not name its hunt: ${JSON.stringify(rev.learnings)}`);

    // ---- 3. the copy's What's working reflects them ----------------------------------------------------------
    const s = (await call('GET', `/v1/flows/${COPY}/review/summary`)).json?.data;
    check(s?.flow === COPY && s?.state === 'ready' && s?.at === rev.at, `the copy's summary: ${JSON.stringify(s)?.slice(0, 300)}`);
    check(s.totals.sent === 12 && s.totals.replied === 5 && s.totals.signups === 1, `the copy's summary totals: ${JSON.stringify(s.totals)}`);
    const best = s.dimensions.find((d) => d.key === 'hunt')?.best;
    check(best?.name === hunt.name && best.sent === 12, `the copy's best hunt: ${JSON.stringify(best)}`);

    // ---- 4. the base flow's review counts none of them --------------------------------------------------------
    const baseRev = run.json.data;
    check(baseRev.scorecard.totals.sent === 0 && baseRev.scorecard.hunts.every((h) => h.sent === 0 && h.drafted === 0), `the base review counted a copy's drafts: ${JSON.stringify(baseRev.scorecard.totals)}`);
    check(read(join(baseDir, 'review.json')).at === baseRev.at, "the base flow's review.json is not the review the route answered");
    const bs = (await call('GET', `/v1/flows/${KEY}/review/summary`)).json?.data;
    check(bs?.totals?.sent === 0 && bs?.state === 'thin', `the base summary: ${JSON.stringify(bs)?.slice(0, 200)}`);

    // ---- 5. a restarted fwd reviews the copy when its review is missing ----------------------------------------
    await f.stop('SIGKILL');
    rmSync(join(copyDir, 'review.json'));
    f = await startFwd(home, { env });
    await waitFor(() => existsSync(join(copyDir, 'review.json')), { timeoutMs: 20000, everyMs: 250, what: "fwd to review the copy by itself after a restart" });
    check(read(join(copyDir, 'review.json')).scorecard.totals.sent === 12, "the copy's review after a restart does not score its drafts");
  } finally {
    freq.close();
    await f.stop('SIGKILL').catch(() => {});
  }
});
