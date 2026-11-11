// Probe for FW-C-107 (the local pulse flow drafts a Thursday roundup of real upcoming events in the
// open sub-areas, and keeps the venue QR poster list): `pnpm probe flows/local-pulse`. Tier 0.
// Surfaces: flows/local-pulse/{stream.json,config.json}; the daemon fwd on a fresh FW_HOME with a
// stand-in Frequency on 127.0.0.1 named by FW_FREQUENCY_URL; the credential file
// $FW_HOME/creds/crd_frequencyoutcomes; the routes POST /v1/flows/local-pulse/run,
// GET /v1/flows/local-pulse, GET /v1/flows/local-pulse/venues,
// POST /v1/flows/local-pulse/venues/{source_tag}/dropped and GET /v1/supervisor/flows/local-pulse/drafts;
// and the files $FW_HOME/flows/local-pulse/{config.json,upcoming.json,venues.json}.
// The surface this probe expects:
//   flows/local-pulse/stream.json is a digest stream on cron "0 8 * * 4" in America/Los_Angeles at tier L1.
//   A run asks Frequency GET /api/webhooks/flowweb-upcoming, signed with the secret behind
//   crd_frequencyoutcomes as hex HMAC-SHA256 of `${x-flowweb-timestamp}.${body}` in x-flowweb-signature.
//   A good answer { events: [...] } replaces upcoming.json; a failed pull (no secret, or an error) keeps
//   upcoming.json as it was and records the reason (GET /v1/flows/local-pulse: last_pull { ok, at, error }).
//   The run then drafts from upcoming.json, keeping only events in the next 14 days whose town is in an
//   open sub-area: one members_email draft, one instagram draft, one local_group draft per group with
//   allows_promo true and no post in the last 7 days, and heads_up drafts for the hosts featured. Each
//   draft waits for the Owner (nothing is handed off). The run answers { groups: [{ name, status }] },
//   status drafted, posted_recently or no_promo.
//   Venues: GET .../venues lists { venue, source_tag, poster_dropped_at, scans_7d }; POST
//   .../venues/{source_tag}/dropped sets poster_dropped_at and writes venues.json. scans_7d is null unless
//   the outcomes pull ($FW_HOME/flows/neighborhood-activation/outcomes.json) carries qr counts.
//
// Proves, in order:
//   1. The stream definition is the Thursday 08:00 digest at L1.
//   2. With no secret the pull fails, upcoming.json (6 events, 2 outside the open sub-areas) is kept
//      byte for byte, and the run still drafts: one email, one Instagram, one post per eligible group
//      (a group posted 3 days ago and a no-promo group are skipped and flagged), heads-ups for the hosts.
//   3. Every roundup draft names the 4 in-area events with title, town and link, none of the 2 others,
//      carries no em or en dash and no count of members.
//   4. With the secret and Frequency answering 500, upcoming.json is unchanged and last_pull says why.
//   5. With Frequency answering 200, fwd's GET is signed and the answer replaces upcoming.json.
//   6. A venue's poster is marked dropped and kept in venues.json; qr counts show as scans_7d.
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, root, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/local-pulse';
const KEY = 'local-pulse';
const SECRET = 'probe-secret-not-real-0123456789abcdef';
const HANDLE = 'crd_frequencyoutcomes';
const DAY = 86_400_000;
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
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 20000 }, (res) => {
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

const at = (days, hour = 18) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour + 1, 30, 0, 0);
  return d.toISOString();
};

const ev = (n, title, town, days) => ({
  event_id: `evt_probe_${n}`,
  title,
  starts_at: at(days),
  town,
  niche: 'sound-bath',
  rsvp_url: `https://frequencylocal.com/e/probe-event-${n}`,
  host_id: `host_probe_${n}`,
});

const IN_AREA = [
  ev(1, 'Sunset Sound Bath', 'Encinitas', 2),
  ev(2, 'Beach Run Club', 'Carlsbad', 4),
  ev(3, 'Watercolor Morning', 'Solana Beach', 6),
  ev(4, 'Board Game Night', 'Del Mar', 9),
];
const OUTSIDE = [ev(5, 'Harbor Knitting Circle', 'Oceanside', 3), ev(6, 'Hill Trail Walk', 'Escondido', 5)];

/** A stand-in Frequency: verifies the signature, records each upcoming read, answers what state says. */
async function fakeFrequency() {
  const seen = [];
  const state = { status: 500 };
  const port = await freePort();
  const server = createHttpServer((req, res) => {
    let text = '';
    req.on('data', (d) => {
      text += d;
    });
    req.on('end', () => {
      if (!String(req.url).startsWith('/api/webhooks/flowweb-upcoming')) {
        res.writeHead(404);
        return res.end();
      }
      const ts = String(req.headers['x-flowweb-timestamp'] ?? '');
      const sig = String(req.headers['x-flowweb-signature'] ?? '');
      const want = createHmac('sha256', SECRET).update(`${ts}.${text}`).digest('hex');
      seen.push({ path: req.url, method: req.method, signed: sig === want });
      if (state.status !== 200) {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        return res.end('{"error":"read failed"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ as_of: new Date().toISOString(), events: [ev(7, 'Fresh Pull Pottery', 'Leucadia', 3)] }));
    });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}`, seen, state, close: () => server.close() };
}

async function startFwd(home, freq) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FREQUENCY_URL: freq.url, FW_OUTCOMES_PULL_EVERY_MS: '3600000' };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

await probe(NAME, async () => {
  // ---- 1. the stream ---------------------------------------------------------------------------
  const repoDir = join(root, 'flows', KEY);
  if (!existsSync(join(repoDir, 'stream.json'))) missing(`flows/${KEY}/stream.json is missing`);
  if (!existsSync(join(repoDir, 'config.json'))) missing(`flows/${KEY}/config.json is missing`);
  const stream = JSON.parse(readFileSync(join(repoDir, 'stream.json'), 'utf8'));
  check(stream.key === KEY && stream.template === 'digest', `stream key ${stream.key}, template ${stream.template}`);
  check(
    stream.trigger?.type === 'cron' && stream.trigger.cron === '0 8 * * 4' && stream.trigger.timezone === 'America/Los_Angeles',
    `stream trigger ${JSON.stringify(stream.trigger)}, want Thursday 08:00 America/Los_Angeles`,
  );
  check(stream.default_tier === 'L1', `stream tier ${stream.default_tier}, want L1`);

  const home = freshHome('local-pulse');
  const freq = await fakeFrequency();
  try {
    const dir = join(home, 'flows', KEY);
    mkdirSync(dir, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(repoDir, 'config.json'), 'utf8'));
    const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
    cfg.groups = [
      { name: 'Leucadia Locals Board', url: 'https://example.com/g/leucadia', allows_promo: true, last_posted_at: null },
      { name: 'Carlsbad Village Neighbors', url: 'https://example.com/g/carlsbad', allows_promo: true, last_posted_at: ago(3) },
      { name: 'Del Mar No Ads Forum', url: 'https://example.com/g/delmar', allows_promo: false, last_posted_at: null },
      { name: 'Solana Beach Weekend Board', url: 'https://example.com/g/solana', allows_promo: true, last_posted_at: ago(10) },
    ];
    cfg.venues = [{ venue: 'Probe Coffee Bar', source_tag: 'qr-probe-coffee', poster_dropped_at: null }];
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    const upFile = join(dir, 'upcoming.json');
    const fixture = `${JSON.stringify({ as_of: new Date().toISOString(), events: [...IN_AREA, ...OUTSIDE] }, null, 2)}\n`;
    writeFileSync(upFile, fixture);

    // ---- 2. no secret: the pull fails, the file is kept, the run drafts from it ------------------
    const f = await startFwd(home, freq);
    const base = `/v1/flows/${KEY}`;
    const run = await http(f.port, 'POST', `${base}/run`, f.token);
    if (run.status === 404 || run.status === 405) missing(`POST ${base}/run answered ${run.status} (no run route)`);
    check(run.status === 200, `POST ${base}/run answered ${run.status}: ${run.body.slice(0, 300)}`);
    check(readFileSync(upFile, 'utf8') === fixture, 'a pull with no secret changed upcoming.json');
    const groups = json(run)?.data?.groups ?? [];
    const status = (n) => groups.find((g) => g.name === n)?.status;
    check(status('Carlsbad Village Neighbors') === 'posted_recently', `group posted 3 days ago: ${status('Carlsbad Village Neighbors')}`);
    check(status('Del Mar No Ads Forum') === 'no_promo', `no-promo group: ${status('Del Mar No Ads Forum')}`);

    const drafts = json(await http(f.port, 'GET', `/v1/supervisor/flows/${KEY}/drafts`, f.token))?.data ?? [];
    const of = (ch) => drafts.filter((d) => d.channel === ch);
    check(of('members_email').length === 1, `members_email drafts: ${of('members_email').length}, want 1`);
    check(of('instagram').length === 1, `instagram drafts: ${of('instagram').length}, want 1`);
    const posts = of('local_group');
    check(posts.length === 2, `local_group drafts: ${posts.length}, want 2 (one per eligible group)`);
    const postText = posts.map((d) => `${d.subject ?? ''} ${d.body}`).join('\n');
    for (const n of ['Leucadia Locals Board', 'Solana Beach Weekend Board'])
      check(postText.includes(n), `no group post names ${n}`);
    for (const n of ['Carlsbad Village Neighbors', 'Del Mar No Ads Forum'])
      check(!postText.includes(n), `a group post was drafted for ${n}`);
    check(of('heads_up').length === IN_AREA.length, `heads_up drafts: ${of('heads_up').length}, want ${IN_AREA.length}`);
    check(drafts.every((d) => d.status === 'waiting_for_owner'), 'a local pulse draft did not wait for the Owner');

    // ---- 3. the content --------------------------------------------------------------------------
    for (const d of [...of('members_email'), ...of('instagram'), ...posts]) {
      const text = `${d.subject ?? ''}\n${d.body}`;
      for (const e of IN_AREA) {
        check(text.includes(e.title), `${d.channel} draft ${d.id} leaves out ${e.title}`);
        check(text.includes(e.town), `${d.channel} draft ${d.id} leaves out the town ${e.town}`);
        check(text.includes(e.rsvp_url), `${d.channel} draft ${d.id} has no link to ${e.title}`);
      }
      for (const e of OUTSIDE) check(!text.includes(e.title), `${d.channel} draft ${d.id} includes ${e.title} from ${e.town}`);
      check(!/[–—]/.test(text), `${d.channel} draft ${d.id} has an em or en dash`);
      check(!/\d[\d,]*\+?\s+(members|neighbors|people)\b/i.test(text), `${d.channel} draft ${d.id} counts members`);
    }
    for (const d of of('heads_up')) check(!/[–—]/.test(d.body), `heads_up draft ${d.id} has a dash`);

    // ---- 4. secret set, Frequency answers 500: the file is kept and the reason recorded ----------
    mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'creds', HANDLE), SECRET, { mode: 0o600 });
    freq.state.status = 500;
    const bad = await http(f.port, 'POST', `${base}/run`, f.token);
    check(bad.status === 200, `a run with Frequency down answered ${bad.status}: ${bad.body.slice(0, 200)}`);
    check(freq.seen.length >= 1, 'fwd never asked Frequency for upcoming events');
    check(readFileSync(upFile, 'utf8') === fixture, 'a failed pull changed upcoming.json');
    const v = json(await http(f.port, 'GET', base, f.token))?.data;
    check(v?.last_pull?.ok === false && typeof v.last_pull.error === 'string', `last_pull after a failure: ${JSON.stringify(v?.last_pull)}`);

    // ---- 5. Frequency answers: a signed GET, and the answer replaces the file --------------------
    freq.state.status = 200;
    freq.seen.length = 0;
    const good = await http(f.port, 'POST', `${base}/run`, f.token);
    check(good.status === 200, `a run with Frequency up answered ${good.status}`);
    const req = freq.seen[0];
    check(req?.method === 'GET', `fwd asked Frequency with ${req?.method}, want GET`);
    check(req?.signed === true, 'the upcoming-events read is not signed with the outcomes secret');
    check(readFileSync(upFile, 'utf8').includes('Fresh Pull Pottery'), 'a good pull did not replace upcoming.json');
    const v2 = json(await http(f.port, 'GET', base, f.token))?.data;
    check(v2?.last_pull?.ok === true, `last_pull after a good pull: ${JSON.stringify(v2?.last_pull)}`);

    // ---- 6. venues -------------------------------------------------------------------------------
    const list = json(await http(f.port, 'GET', `${base}/venues`, f.token))?.data;
    const venue = (l) => (Array.isArray(l) ? l : (l?.venues ?? [])).find((x) => x.source_tag === 'qr-probe-coffee');
    check(venue(list)?.venue === 'Probe Coffee Bar', `GET ${base}/venues: ${JSON.stringify(list).slice(0, 300)}`);
    check(venue(list).poster_dropped_at === null && venue(list).scans_7d === null, `fresh venue: ${JSON.stringify(venue(list))}`);
    const drop = await http(f.port, 'POST', `${base}/venues/qr-probe-coffee/dropped`, f.token, {});
    check(drop.status === 200, `marking a poster dropped answered ${drop.status}: ${drop.body.slice(0, 200)}`);
    const file = JSON.parse(readFileSync(join(dir, 'venues.json'), 'utf8'));
    const saved = venue(file);
    check(typeof saved?.poster_dropped_at === 'string', `venues.json after the drop: ${JSON.stringify(file).slice(0, 300)}`);
    const na = join(home, 'flows', 'neighborhood-activation');
    mkdirSync(na, { recursive: true });
    writeFileSync(
      join(na, 'outcomes.json'),
      JSON.stringify({ pulled_at: new Date().toISOString(), outcomes: [], regions: [], qr: [{ source_tag: 'qr-probe-coffee', scans_7d: 5 }] }),
    );
    const after = venue(json(await http(f.port, 'GET', `${base}/venues`, f.token))?.data);
    check(after?.scans_7d === 5 && typeof after.poster_dropped_at === 'string', `venue with qr counts: ${JSON.stringify(after)}`);
  } finally {
    freq.close();
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
