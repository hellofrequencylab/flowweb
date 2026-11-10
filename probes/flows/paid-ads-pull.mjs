// Probe for FW-C-058 (paid ads, automatic Google Analytics pull): `pnpm probe flows/paid-ads-pull`. Tier 0.
// Surfaces: the shipped config in flows/paid-ads/config.json, the daemon fwd (one node process on a
// fresh FW_HOME), a local fake of Google's token endpoint and the GA4 Data API (FW_GA4_TOKEN_URL and
// FW_GA4_API_BASE point fwd at it), a service account key behind a credential handle file in
// $FW_HOME/creds/, and GET /v1/flows/paid-ads with the CLI token fwd prints.
//
// Proves, in order:
//   1. The shipped config names a GA4 property and a credential handle (never a key).
//   2. With the key in place, fwd pulls on its own, with no request from anyone: it signs in with an
//      RS256 assertion for the read-only Analytics scope that the key's public half verifies, asks
//      runReport for the configured property with a Bearer token, and the view's totals then match
//      the fake's rows for the campaign (another campaign's rows do not count). pull.last.ok is true.
//   3. With no key, fwd still serves the view; pull.last.ok is false and its error names the
//      handle. The private key text never appears in fwd's output or the view.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttp, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, root, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/paid-ads-pull';
const KEY = 'paid-ads';
const PROPERTY = '424242';
const HANDLE = 'crd_probega4';
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

function httpGet(port, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${token}` }, timeout: 5000 },
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

/** A fake Google: POST /token answers an access token, POST .../properties/{id}:runReport answers rows. */
function fakeGoogle(rows) {
  const seen = [];
  const server = createHttp((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/token') return res.end(JSON.stringify({ access_token: 'probe-token', expires_in: 3600 }));
      if (req.method === 'POST' && /^\/v1beta\/properties\/[^/]+:runReport$/.test(req.url)) return res.end(JSON.stringify({ rows }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

async function startFwd(home, env) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home, ...env } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function view(f) {
  const r = await httpGet(f.port, `/v1/flows/${KEY}`, f.token);
  check(r.status === 200, `GET /v1/flows/${KEY} answered ${r.status}: ${r.body.slice(0, 200)}`);
  return { v: JSON.parse(r.body).data, raw: r.body };
}

async function pulled(f) {
  let last;
  await waitFor(
    async () => {
      last = (await view(f)).v;
      return last.pull?.last != null;
    },
    { timeoutMs: 20000, what: 'fwd to pull from Google Analytics on its own' },
  ).catch(() => {});
  if (last?.pull === undefined) missing('GET /v1/flows/paid-ads has no pull field (no automatic pull)');
  check(last.pull?.last != null, 'fwd never recorded a Google Analytics pull (pull.last stayed null for 20 s)');
  return last;
}

const ymd = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
const row = (d, campaign, m) => ({ dimensionValues: [{ value: d }, { value: campaign }], metricValues: m.map((value) => ({ value: String(value) })) });
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.01;

await probe(NAME, async () => {
  // ---- 1. shipped config ---------------------------------------------------------------------
  const cfg = JSON.parse(readFileSync(join(root, `flows/${KEY}/config.json`), 'utf8'));
  if (!cfg.ga4) missing('flows/paid-ads/config.json has no ga4 block (no automatic pull configured)');
  check(/^\d+$/.test(String(cfg.ga4.property_id ?? '')), 'config.json ga4.property_id is not a GA4 property number');
  check(/^crd_[0-9A-Za-z]{4,40}$/.test(String(cfg.ga4.credential ?? '')), 'config.json ga4.credential is not a credential handle');
  check(!/PRIVATE KEY/.test(JSON.stringify(cfg)), 'config.json holds key material');
  const campaign = cfg.campaign.name;

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyLine = pem.split('\n')[1];
  const g = await fakeGoogle([
    row(ymd(3), campaign, [1000, 20, 12.5, 1]),
    row(ymd(2), campaign, [2000, 30, 7.5, 0]),
    row(ymd(2), 'Some other campaign', [9999, 999, 1000, 50]),
  ]);
  const env = { FW_GA4_TOKEN_URL: `${g.base}/token`, FW_GA4_API_BASE: g.base };
  const writeHome = (home, withKey) => {
    const dir = join(home, 'flows', KEY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...cfg, ga4: { ...cfg.ga4, property_id: PROPERTY, credential: HANDLE } }));
    if (withKey) {
      mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'creds', HANDLE), JSON.stringify({ client_email: 'probe@probe.iam.gserviceaccount.com', private_key: pem }), { mode: 0o600 });
    }
  };
  try {
    // ---- 2. with the key: fwd pulls on its own ---------------------------------------------------
    const home = freshHome('ads-pull');
    writeHome(home, true);
    const f = await startFwd(home, env);
    const v = await pulled(f);
    check(v.pull.last.ok === true, `the pull failed: ${v.pull.last.error}`);
    check(v.pull.property_id === PROPERTY, `pull.property_id is ${v.pull.property_id}, want ${PROPERTY}`);
    const tok = g.seen.find((s) => s.url === '/token');
    check(tok, 'fwd never asked Google for a token');
    const jwt = new URLSearchParams(tok.body).get('assertion') ?? '';
    const [h, b, s] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(b ?? '', 'base64url').toString() || '{}');
    check(claims.scope === 'https://www.googleapis.com/auth/analytics.readonly', `token scope is ${claims.scope}, want analytics.readonly only`);
    check(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s ?? '', 'base64url')), 'the sign-in assertion does not verify with the key');
    const rep = g.seen.find((x) => x.url === `/v1beta/properties/${PROPERTY}:runReport`);
    check(rep, `fwd never called runReport for property ${PROPERTY}`);
    check(rep.auth === 'Bearer probe-token', 'runReport was not called with the access token');
    check(near(v.totals?.spend_usd, 20), `spend is ${v.totals?.spend_usd}, want 20 (another campaign counted?)`);
    check(v.totals?.clicks === 50 && v.totals?.impressions === 3000, `clicks/impressions are ${v.totals?.clicks}/${v.totals?.impressions}, want 50/3000`);
    check(near(v.totals?.subscriptions, 1), `subscriptions are ${v.totals?.subscriptions}, want 1`);
    check(!f.d.output().includes(keyLine), 'fwd printed the private key');

    // ---- 3. no key: a visible failure, not a crash ------------------------------------------------
    const home2 = freshHome('ads-nokey');
    writeHome(home2, false);
    const f2 = await startFwd(home2, env);
    const v2 = await pulled(f2);
    check(v2.pull.last.ok === false, 'a pull with no key reported success');
    check(String(v2.pull.last.error).includes(HANDLE), `the failed pull does not name the handle: ${v2.pull.last.error}`);
    check(f2.d.exitCode === null, 'fwd exited after a failed pull');
    check(!(await view(f2)).raw.includes(keyLine) && !f2.d.output().includes(keyLine), 'the private key leaked');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
    g.server.close();
  }
});
