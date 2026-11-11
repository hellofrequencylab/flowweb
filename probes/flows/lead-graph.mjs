// Probe for FW-C-103 (the lead graph: every lead is a scored node that approves itself when strong):
// `pnpm probe flows/lead-graph`. Tier 0.
// Surfaces: the daemon fwd (one node process on a fresh FW_HOME with FW_VENDOR=fake, no network or keys),
// the lead routes under /v1/flows/neighborhood-activation/leads with the CLI token fwd prints, the
// existing do-not-contact route, and the hunt drafts folder $FW_HOME/flows/<key>/drafts/, which this
// probe fills with draft files shaped like the ones a hunt cycle writes (hunt_id, name, to, source_url,
// event { title, starts_at, url, country }, region, send_via), plus the optional kind and niche.
// The surface this probe expects:
//   GET /v1/flows/{key}/leads[?state=proposed|approved|dropped] reads the flow's hunt drafts (read only),
//   upserts them into $FW_HOME/flows/<key>/leads.json, rescores, and answers { data: [node] }. A node has
//   id, kind (person|venue), name, niche, town, contact_routes [{ kind, value, public_source_url }],
//   source_url, last_event_at, current_tool, consent_note, state, score { p_reply, p_publish, leverage,
//   timing, value }, links { venues, events, referred_by }, warm and created_at. Nodes dedupe by
//   normalized email, handle, domain and name plus town. A person found on a venue's own site links to
//   that venue, and each linked teacher raises the venue's leverage. value = p_reply x p_publish x
//   leverage x timing; at or above the approve threshold (0.6 by default) a node approves itself, from
//   0.45 it stays proposed, below it drops. Do-not-contact and restricted regions always drop.
//   POST .../leads/{id}/approve and .../drop are the Owner's tap; approving a blocked node answers 409.
//   POST .../leads/paste { text } adds people the Owner met in person, one per line, as warm nodes.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/lead-graph';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/leads`;
const kids = [];
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

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

const draft = (id, name, to, source, ev, extra = {}) => ({
  flow: KEY,
  id,
  hunt_id: 'hnt_probe',
  to,
  name,
  source_url: source,
  event: { title: ev.title, starts_at: ev.at, url: ev.url, country: 'US' },
  region: 'north-county-sd',
  send_via: 'email',
  channel: 'frequency',
  subject: `About ${ev.title}`,
  body: 'Hi',
  status: 'waiting_for_owner',
  created_at: ago(0),
  ...extra,
});

const DRAFTS = [
  // The same person found twice by hunts: one node, two events, a ticket seller, a fresh event.
  draft('a1', 'Maya Rivers', 'maya@riverssound.com', 'https://riverssound.com/about', {
    title: 'Full moon sound bath',
    at: ago(1),
    url: 'https://www.eventbrite.com/e/full-moon-1',
  }),
  draft('a2', 'Maya Rivers', 'Maya@RiversSound.com', 'https://riverssound.com/events', {
    title: 'New moon sound bath',
    at: ago(9),
    url: 'https://www.eventbrite.com/e/new-moon-2',
  }),
  // A venue and two teachers found on its own site.
  draft('v1', 'Coastal Studio', 'hello@coastalstudio.com', 'https://coastalstudio.com/', {
    title: 'Weekly schedule',
    at: ago(2),
    url: 'https://coastalstudio.com/schedule',
  }, { kind: 'venue', niche: 'yoga' }),
  draft('t1', 'Ana Lopez', 'ana.lopez@gmail.com', 'https://coastalstudio.com/teachers/ana', {
    title: 'Slow flow',
    at: ago(2),
    url: 'https://coastalstudio.com/schedule/slow-flow',
  }, { niche: 'yoga' }),
  draft('t2', 'Ben Ortiz', 'ben.ortiz@gmail.com', 'https://www.coastalstudio.com/teachers/ben', {
    title: 'Breathwork',
    at: ago(2),
    url: 'https://coastalstudio.com/schedule/breathwork',
  }, { niche: 'yoga' }),
  // A venue nobody teaches at yet.
  draft('v2', 'Quiet Room', 'info@quietroom.org', 'https://quietroom.org/', {
    title: 'Open studio',
    at: ago(2),
    url: 'https://quietroom.org/open',
  }, { kind: 'venue', niche: 'yoga' }),
  // As strong as Maya, but on do-not-contact.
  draft('b1', 'Blocked Host', 'host@blocked.example.org', 'https://blocked.example.org/', {
    title: 'Drum circle',
    at: ago(1),
    url: 'https://www.eventbrite.com/e/drum-circle-1',
  }),
  // In the UK: a restricted region.
  draft('r1', 'Lee Grant', 'lee@harbourstudio.co.uk', 'https://harbourstudio.co.uk/', {
    title: 'Sound bath',
    at: ago(1),
    url: 'https://harbourstudio.co.uk/events',
  }),
];

async function startFwd(home) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake' };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

await probe(NAME, async () => {
  const home = realpathSync(freshHome('lead-graph'));
  try {
    const drafts = join(home, 'flows', KEY, 'drafts');
    mkdirSync(drafts, { recursive: true });
    for (const d of DRAFTS) writeFileSync(join(drafts, `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`);
    const f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);

    const anon = await http(f.port, 'GET', BASE, null);
    if (anon.status === 404 || anon.status === 405) missing(`GET ${BASE} answered ${anon.status} (no lead graph routes)`);
    check(anon.status === 401, `reading leads without a token answered ${anon.status}, want 401`);
    const dnc = await api('POST', `/v1/flows/${KEY}/do-not-contact`, { email: 'host@blocked.example.org', reason: 'asked not to be contacted' });
    check(dnc.status === 200, `adding an address to do-not-contact answered ${dnc.status}: ${dnc.body.slice(0, 200)}`);

    const list = async (q = '') => {
      const r = await api('GET', `${BASE}${q}`);
      if (r.status === 404) missing(`GET ${BASE}${q} answered 404`);
      check(r.status === 200, `GET ${BASE}${q} answered ${r.status}: ${r.body.slice(0, 200)}`);
      const data = json(r)?.data;
      check(Array.isArray(data), `GET ${BASE}${q} did not answer { data: [node] }: ${r.body.slice(0, 200)}`);
      return data;
    };
    const nodes = await list();
    const named = (n) => nodes.filter((x) => x.name === n);
    for (const k of ['id', 'kind', 'contact_routes', 'state', 'score', 'links', 'warm', 'created_at'])
      check(k in (nodes[0] ?? {}), `a node has no ${k}: ${JSON.stringify(nodes[0]).slice(0, 300)}`);

    // 1. Two hunt results for the same person dedupe to one node with both events.
    check(named('Maya Rivers').length === 1, `Maya Rivers is ${named('Maya Rivers').length} nodes, want 1`);
    const maya = named('Maya Rivers')[0];
    check(maya.links.events.length === 2, `Maya's node has ${maya.links.events.length} events, want 2`);
    for (const p of ['p_reply', 'p_publish', 'leverage', 'timing', 'value'])
      check(typeof maya.score[p] === 'number', `Maya's score has no number ${p}: ${JSON.stringify(maya.score)}`);
    const product = maya.score.p_reply * maya.score.p_publish * maya.score.leverage * maya.score.timing;
    check(Math.abs(product - maya.score.value) < 0.01, `value ${maya.score.value} is not the product of its parts (${product.toFixed(3)})`);

    // 2. A venue and two teachers link, and the teachers raise the venue's leverage.
    const venue = named('Coastal Studio')[0];
    const quiet = named('Quiet Room')[0];
    check(venue?.kind === 'venue' && quiet?.kind === 'venue', 'the two venues are not venue nodes');
    for (const t of ['Ana Lopez', 'Ben Ortiz']) {
      const n = named(t)[0];
      check(n?.kind === 'person', `${t} is not a person node`);
      check(n.links.venues.includes(venue.id), `${t} is not linked to Coastal Studio: ${JSON.stringify(n.links)}`);
    }
    check(venue.score.leverage > quiet.score.leverage, `Coastal Studio's leverage ${venue.score.leverage} is not above Quiet Room's ${quiet.score.leverage}`);

    // 3. Strong approves itself, borderline waits, do-not-contact and restricted drop.
    check(maya.state === 'approved', `Maya (value ${maya.score.value}) is ${maya.state}, want approved`);
    check(venue.state === 'approved', `Coastal Studio (value ${venue.score.value}) is ${venue.state}, want approved`);
    const ana = named('Ana Lopez')[0];
    check(ana.state === 'proposed', `Ana Lopez (value ${ana.score.value}) is ${ana.state}, want proposed`);
    check(ana.score.value >= 0.45 && ana.score.value < 0.6, `Ana Lopez's value ${ana.score.value} is not borderline`);
    check(named('Blocked Host')[0]?.state === 'dropped', 'the do-not-contact host is not dropped');
    check(named('Lee Grant')[0]?.state === 'dropped', 'the UK lead is not dropped');
    const approved = await list('?state=approved');
    check(approved.every((n) => n.state === 'approved') && approved.some((n) => n.id === maya.id), '?state=approved does not filter');

    // The Owner's tap: approve a borderline lead, and approving a blocked one is refused.
    const ok = await api('POST', `${BASE}/${ana.id}/approve`);
    check(ok.status === 200 && json(ok)?.data?.state === 'approved', `approving Ana answered ${ok.status}: ${ok.body.slice(0, 200)}`);
    const no = await api('POST', `${BASE}/${named('Blocked Host')[0].id}/approve`);
    check(no.status === 409, `approving a do-not-contact lead answered ${no.status}, want 409`);
    const drop = await api('POST', `${BASE}/${quiet.id}/drop`);
    check(drop.status === 200 && json(drop)?.data?.state === 'dropped', `dropping Quiet Room answered ${drop.status}`);
    const again = await list();
    check(again.find((n) => n.id === ana.id)?.state === 'approved', 'the Owner approval did not stick after a refresh');
    check(again.find((n) => n.id === quiet.id)?.state === 'dropped', 'the Owner drop did not stick after a refresh');

    // 4. A paste of three people met in person makes three warm nodes.
    const text = 'Jess Park, Leucadia jam, jess@example.com\nTom Reyes - library sound circle - @tomreyes\nLina Cho, farmers market\n';
    const paste = await api('POST', `${BASE}/paste`, { text });
    check(paste.status === 200, `pasting names answered ${paste.status}: ${paste.body.slice(0, 200)}`);
    const warm = (await list()).filter((n) => ['Jess Park', 'Tom Reyes', 'Lina Cho'].includes(n.name));
    check(warm.length === 3, `the paste made ${warm.length} nodes, want 3: ${warm.map((n) => n.name).join(', ')}`);
    check(warm.every((n) => n.warm === 'met_in_person' && n.kind === 'person'), `pasted nodes are not warm people: ${warm.map((n) => n.warm).join(', ')}`);
    check(warm.find((n) => n.name === 'Jess Park').contact_routes.some((r) => r.kind === 'email' && r.value === 'jess@example.com'), 'Jess Park has no email route');
    const twice = await api('POST', `${BASE}/paste`, { text });
    check(twice.status === 200, `pasting again answered ${twice.status}`);
    const after = (await list()).filter((n) => ['Jess Park', 'Tom Reyes', 'Lina Cho'].includes(n.name));
    check(after.length === 3, `pasting the same names again made ${after.length} nodes, want 3`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});
