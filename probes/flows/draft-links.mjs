// Probe for FW-C-084 (outreach drafts read like a person wrote them): `pnpm probe flows/draft-links`.
// Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME (FW_VENDOR=fake, FW_FAKE_SCENARIO=hunt_leads), a stand-in
// Frequency on 127.0.0.1 named by FW_FREQUENCY_URL, the credential file $FW_HOME/creds/crd_frequencyoutcomes,
// the hunt routes under /v1/flows/neighborhood-activation/hunts with the CLI token fwd prints, and the
// drafts folder $FW_HOME/flows/neighborhood-activation/drafts/.
// The surface this probe expects:
//   For every link fwd puts in a draft that carries utm_source=flowweb, fwd POSTs { url, title } to
//   <Frequency>/api/webhooks/flowweb-link (frequency-web LIVE-2257), signed with the secret behind
//   crd_frequencyoutcomes as hex HMAC-SHA256 of `${x-flowweb-timestamp}.${body}` in x-flowweb-signature,
//   and puts the short_url Frequency answers (…/q/<slug>) in the draft instead. The posted url still
//   carries utm_campaign and utm_content.
//   No draft subject or body holds an em dash or an en dash, even when the model wrote one. When Frequency
//   does not answer, the draft keeps its long link and is still written.
//
// Proves, in order:
//   1. A hunt run with Frequency up writes drafts whose only Frequency link is a /q/ short link, after a
//      signed post naming the long link with its utm_content.
//   2. Those drafts hold no em or en dash.
//   3. With Frequency down, the next hunt's drafts are still written, with the long link.
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/draft-links';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/hunts`;
const SECRET = 'probe-secret-not-real-0123456789abcdef';
const HANDLE = 'crd_frequencyoutcomes';
const DASH = /[–—]/;
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

/** A stand-in Frequency: verifies the signature, answers short links, and says synced to anything else. */
async function fakeFrequency() {
  const seen = [];
  const state = { up: true, n: 0 };
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
      if (!state.up) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"down"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/webhooks/flowweb-link') {
        state.n++;
        return res.end(JSON.stringify({ short_url: `https://frequencylocal.com/q/prb${String(state.n).padStart(4, '0')}` }));
      }
      res.end(JSON.stringify({ status: 'off', outcomes: [], regions: [] }));
    });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}`, seen, state, close: () => server.close() };
}

const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []);
const readAll = (dir) => filesIn(dir).map((x) => JSON.parse(readFileSync(join(dir, x), 'utf8')));

await probe(NAME, async () => {
  const home = freshHome('draft-links');
  const freq = await fakeFrequency();
  try {
    mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'creds', HANDLE), SECRET, { mode: 0o600 });
    const port = await freePort();
    const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads', FW_FREQUENCY_URL: freq.url, FW_OUTCOMES_PULL_EVERY_MS: '3600000' };
    const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
    check(tokenPath, 'fwd did not print "CLI token file: <path>"');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const api = (method, path, body) => http(port, method, path, token, body);
    const drafts = join(home, 'flows', KEY, 'drafts');
    const linkPosts = () => freq.seen.filter((x) => x.path === '/api/webhooks/flowweb-link');

    const en = await api('POST', `/v1/supervisor/flows/${KEY}/enable`);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}`);

    async function huntOnce(name) {
      const made = await api('POST', BASE, { name, looking_for: 'craft workshops', region: 'north-county-sd', max_sends: 2 });
      if (made.status === 404) missing(`POST ${BASE} answered 404 (no hunt routes)`);
      check(made.status === 201, `saving a hunt answered ${made.status}: ${made.body.slice(0, 200)}`);
      const id = json(made)?.data?.id;
      const run = await api('POST', `${BASE}/${id}/run`);
      check(run.status === 200 && json(run)?.data?.outcome === 'fired', `running the hunt answered ${run.status}: ${run.body.slice(0, 200)}`);
      await waitFor(() => readAll(drafts).filter((x) => x.hunt_id === id).length >= 2, { timeoutMs: 30000, everyMs: 250, what: `drafts for hunt ${id}` });
      return readAll(drafts).filter((x) => x.hunt_id === id);
    }

    // ---- 1. short links ---------------------------------------------------------------------------------
    const first = await huntOnce('Craft workshops');
    check(linkPosts().length > 0, 'fwd never asked Frequency for a short link');
    for (const p of linkPosts()) {
      check(p.signed, 'a short-link post does not carry a signature that verifies');
      const u = new URL(String(p.body?.url ?? ''));
      check(u.searchParams.get('utm_source') === 'flowweb' && u.searchParams.get('utm_content'), `the posted url lost its utm params: ${p.body?.url}`);
      check(typeof p.body?.title === 'string' && p.body.title.length > 0, 'a short-link post has no title');
    }
    for (const x of first) {
      const body = String(x.body ?? '');
      check(/https:\/\/frequencylocal\.com\/q\/prb\d{4}/.test(body), `a draft has no short link: ${body.slice(0, 300)}`);
      check(!/\/start\/host\?/.test(body), 'a draft still carries the long funnel link');
      // ---- 2. dashes ---------------------------------------------------------------------------------------
      check(!DASH.test(body) && !DASH.test(String(x.subject ?? '')), `a draft holds an em or en dash: ${body.slice(0, 200)}`);
    }

    // ---- 3. Frequency down keeps the long link ----------------------------------------------------------
    freq.state.up = false;
    const second = await huntOnce('Paper crafts');
    for (const x of second) {
      const body = String(x.body ?? '');
      check(/\/start\/host\?[^\s]*utm_source=flowweb/.test(body), `with Frequency down a draft lost its link: ${body.slice(0, 300)}`);
      check(!DASH.test(body), 'with Frequency down a draft holds an em or en dash');
    }
  } finally {
    freq.close();
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
