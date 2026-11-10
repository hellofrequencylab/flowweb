// Probe for FW-C-055 (fwd pulls each day what became of the people a flow reached, from Frequency):
// `pnpm probe flows/outcome-pull`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME, a stand-in Frequency on 127.0.0.1 named by
// FW_FREQUENCY_URL, the credential file $FW_HOME/creds/crd_frequencyoutcomes, the flow routes under
// /v1/flows/neighborhood-activation with the CLI token fwd prints, and the flow's files under
// $FW_HOME/flows/neighborhood-activation/.
// The surface this probe expects:
//   fwd POSTs { since } to <Frequency>/api/webhooks/flowweb-outcomes, signed with the secret behind
//   credential handle crd_frequencyoutcomes as hex HMAC-SHA256 of `${x-flowweb-timestamp}.${body}` in
//   x-flowweb-signature (Frequency LIVE-2255). It pulls once soon after it starts and then every
//   FW_OUTCOMES_PULL_EVERY_MS (default one day), and on POST /v1/flows/neighborhood-activation/outcomes/pull.
//   A good answer is written to outcomes.json { as_of, pulled_at, since, outcomes, regions }, keeping only
//   campaign, content, medium, src, leads, members, hosts and paid on each outcome row, and each region's
//   four numbers become the region's measures in state.json, as a metrics upload would.
//   GET /v1/flows/neighborhood-activation/outcomes answers { data: outcomes.json plus last_pull }.
//   A failed pull (Frequency down or answering an error, or no secret) keeps the last good outcomes.json
//   and measures and records last_pull { ok: false, at, error }; the pull route answers 502, or 409 naming
//   the handle when there is no secret. Nothing is pulled from anywhere but the flow's Frequency.
//
// Proves, in order:
//   1. With no secret, a pull answers 409 naming crd_frequencyoutcomes and writes no outcomes.json.
//   2. With the secret, fwd pulls on its own soon after it starts: Frequency sees a request whose
//      signature verifies and whose body names since.
//   3. The pull route needs the CLI token (401 without) and answers 200 with the counts.
//   4. outcomes.json holds the rows, a field that names a person is dropped, and the region numbers
//      are now the measures in state.json.
//   5. When Frequency answers 500, the pull answers 502, outcomes.json and the measures are unchanged,
//      and GET .../outcomes shows last_pull ok false with the error.
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/outcome-pull';
const KEY = 'neighborhood-activation';
const SECRET = 'probe-secret-not-real-0123456789abcdef';
const HANDLE = 'crd_frequencyoutcomes';
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


/** A stand-in Frequency: verifies the signature, records each request, answers what `answer` says. */
async function fakeFrequency() {
  const seen = [];
  const state = { status: 200 };
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
      seen.push({ path: req.url, method: req.method, signed: sig === want, body: text });
      if (state.status !== 200) {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        return res.end('{"error":"read failed"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          as_of: '2026-11-10T12:00:00.000Z',
          since: '2026-08-12T12:00:00.000Z',
          outcomes: [
            { campaign: 'hnt_aaaaaaaaaaaa', content: 'hnt_aaaaaaaaaaaa-111111111111', medium: 'email', src: 'hunt', leads: 3, members: 2, hosts: 1, paid: 0, email: 'someone@example.com' },
            { campaign: 'north-county-sd', content: null, medium: 'founder_email', src: 'event_listings', leads: 1, members: 1, hosts: 0, paid: 1 },
          ],
          regions: [
            { territory_id: 'north-county-sd', hosts_active_28d: 12, events_next_14d: 9, sub_areas_covered_14d: 2, wam: 140 },
            { territory_id: 'orange-county', hosts_active_28d: 0, events_next_14d: 0, sub_areas_covered_14d: 0, wam: 3 },
          ],
        }),
      );
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
  const home = freshHome('outcome-pull');
  const freq = await fakeFrequency();
  try {
    const flowDir = join(home, 'flows', KEY);
    const outFile = join(flowDir, 'outcomes.json');
    const base = `/v1/flows/${KEY}/outcomes`;

    // ---- 1. no secret: refused, nothing written -------------------------------------------------------
    let f = await startFwd(home, freq);
    const none = await http(f.port, 'POST', `${base}/pull`, f.token);
    if (none.status === 404 || none.status === 405) missing(`POST ${base}/pull answered ${none.status} (no pull route)`);
    check(none.status === 409 && none.body.includes(HANDLE), `a pull with no secret answered ${none.status}: ${none.body.slice(0, 200)}`);
    check(!existsSync(outFile), 'a pull with no secret wrote outcomes.json');
    await killAndWait(f.d, 'SIGKILL');

    // ---- 2. with the secret, fwd pulls on its own -----------------------------------------------------
    mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'creds', HANDLE), SECRET, { mode: 0o600 });
    freq.seen.length = 0;
    f = await startFwd(home, freq);
    await waitFor(() => freq.seen.length > 0, { timeoutMs: 20000, everyMs: 250, what: 'fwd to pull from Frequency on its own' });
    const first = freq.seen[0];
    check(first.method === 'POST' && first.path === '/api/webhooks/flowweb-outcomes', `fwd called ${first.method} ${first.path}`);
    check(first.signed, 'the request fwd sent does not carry a signature that verifies');
    check(typeof JSON.parse(first.body).since === 'string', `the request body names no since: ${first.body}`);

    // ---- 3. the pull route --------------------------------------------------------------------------
    check((await http(f.port, 'POST', `${base}/pull`, null)).status === 401, 'a pull without the token was not refused');
    const ok = await http(f.port, 'POST', `${base}/pull`, f.token);
    check(ok.status === 200, `a pull answered ${ok.status}: ${ok.body.slice(0, 200)}`);

    // ---- 4. what was written --------------------------------------------------------------------------
    const file = JSON.parse(readFileSync(outFile, 'utf8'));
    check(Array.isArray(file.outcomes) && file.outcomes.length === 2, `outcomes.json rows: ${JSON.stringify(file.outcomes)}`);
    const hunt = file.outcomes.find((r) => r.campaign === 'hnt_aaaaaaaaaaaa');
    check(hunt?.members === 2 && hunt?.hosts === 1 && hunt?.content === 'hnt_aaaaaaaaaaaa-111111111111', `the hunt row: ${JSON.stringify(hunt)}`);
    check(!JSON.stringify(file).includes('someone@example.com'), 'outcomes.json kept a field that names a person');
    check(typeof file.pulled_at === 'string', 'outcomes.json has no pulled_at');
    const state = JSON.parse(readFileSync(join(flowDir, 'state.json'), 'utf8'));
    const m = state.metrics?.['north-county-sd'];
    check(
      m?.hosts_active_28d === 12 && m?.events_next_14d === 9 && m?.sub_areas_covered_14d === 2 && m?.wam === 140,
      `the region numbers did not become the measures: ${JSON.stringify(m)}`,
    );
    const view = json(await http(f.port, 'GET', base, f.token))?.data;
    check(view?.outcomes?.length === 2 && view?.last_pull?.ok === true, `GET ${base}: ${JSON.stringify(view).slice(0, 300)}`);

    // ---- 5. a failed pull keeps the last good numbers ---------------------------------------------------
    const before = readFileSync(outFile, 'utf8');
    freq.state.status = 500;
    const bad = await http(f.port, 'POST', `${base}/pull`, f.token);
    check(bad.status === 502, `a pull Frequency refused answered ${bad.status}, want 502`);
    check(readFileSync(outFile, 'utf8') === before, 'a failed pull changed outcomes.json');
    const after = JSON.parse(readFileSync(join(flowDir, 'state.json'), 'utf8')).metrics?.['north-county-sd'];
    check(after?.wam === 140, `a failed pull changed the measures: ${JSON.stringify(after)}`);
    const v2 = json(await http(f.port, 'GET', base, f.token))?.data;
    check(v2?.last_pull?.ok === false && typeof v2.last_pull.error === 'string', `last_pull after a failure: ${JSON.stringify(v2?.last_pull)}`);
  } finally {
    freq.close();
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
