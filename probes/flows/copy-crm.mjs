// Probe for FW-C-158 (leads a flow copy drafts for reach Frequency's CRM, as the base flow's do):
// `pnpm probe flows/copy-crm`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME, a stand-in Frequency on 127.0.0.1 named by
// FW_FREQUENCY_URL, the credential file $FW_HOME/creds/crd_frequencyoutcomes (the root home only), the
// base flow's drafts folder $FW_HOME/flows/neighborhood-activation/drafts/ and a copy's drafts folder
// $FW_HOME/copies/neighborhood-activation--coaches-guides/flows/neighborhood-activation/drafts/.
// The surface this probe expects:
//   The CRM sync of FW-C-065 covers the base flow and every copy that has a home under $FW_HOME/copies/.
//   A copy's email draft is posted to <Frequency>/api/webhooks/flowweb-crm, signed with the same secret,
//   with `flow` set to the copy's key, and Frequency's answer is written onto the copy's draft file as crm.
//   The base flow's draft is still posted with `flow` neighborhood-activation. A copy's contact-form draft
//   is never posted. POST /v1/flows/neighborhood-activation/crm/sync counts both and posts nothing twice.
//
// Proves, in order:
//   1. Soon after it starts, fwd posts the copy's email draft, signed, naming the copy as its flow, and the
//      copy's draft file records crm synced.
//   2. The base flow's draft is posted too, naming the base flow.
//   3. The copy's contact-form draft is never posted.
//   4. A sync with nothing changed posts nothing.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/copy-crm';
const COPY = `${'neighborhood-activation'}--coaches-guides`;
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

/** A stand-in Frequency CRM: verifies the signature, records each post, answers where the lead is. */
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
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      seen.push({ path: req.url, signed: sig === want, body });
      if (state.status !== 200) {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        return res.end('{"status":"error"}');
      }
      const d = body?.draft ?? {};
      const lead_status = d.declined_at ? 'closed' : d.replied_at ? 'in_progress' : d.sent_at ? 'waiting' : 'open';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'synced',
          contact_id: 'c-1',
          conversation_id: 'conv-1',
          conversation_url: `http://127.0.0.1:${port}/admin/crm/conversations?id=conv-1`,
          lead_status,
          signed_up: false,
          added: 1,
        }),
      );
    });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}`, seen, state, close: () => server.close() };
}

function draft(id, extra) {
  return {
    flow: KEY,
    id,
    fire_id: 'fire-probe',
    hunt_id: 'hnt_probe',
    name: 'Front Porch Gallery',
    source_url: 'https://frontporch.example/events',
    region: 'north-county-sd',
    channel: 'frequency',
    subject: 'A local connection',
    body: 'Hi Front Porch Gallery team. https://frequencylocal.com/start/host?utm_source=flowweb',
    tag: id.toLowerCase(),
    status: 'waiting_for_owner',
    created_at: new Date().toISOString(),
    ...extra,
  };
}

await probe(NAME, async () => {
  const home = freshHome('copy-crm');
  const freq = await fakeFrequency();
  try {
    const baseDir = join(home, 'flows', KEY, 'drafts');
    const copyDir = join(home, 'copies', COPY, 'flows', KEY, 'drafts');
    for (const d of [baseDir, copyDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const put = (dir, d) => writeFileSync(join(dir, `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
    put(baseDir, draft('hnt_probe-base00000001', { to: 'hello@frontporch.example', send_via: 'email' }));
    put(copyDir, draft('hnt_probe-copy00000001', { to: 'coach@stillwater.example', send_via: 'email', name: 'Stillwater Coaching' }));
    put(copyDir, draft('hnt_probe-copyform0002', { to: null, contact_url: 'https://form.example/contact', send_via: 'contact_form' }));
    const read = (dir, id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
    mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'creds', HANDLE), SECRET, { mode: 0o600 });

    const port = await freePort();
    const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FREQUENCY_URL: freq.url, FW_OUTCOMES_PULL_EVERY_MS: '3600000' };
    const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
    check(tokenPath, 'fwd did not print "CLI token file: <path>"');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const crmPosts = () => freq.seen.filter((x) => x.path === '/api/webhooks/flowweb-crm');
    const postFor = (email) => crmPosts().find((x) => x.body?.lead?.email === email);

    // ---- 1. the copy's email lead is posted, naming the copy ---------------------------------------------
    await waitFor(() => postFor('hello@frontporch.example'), { timeoutMs: 20000, everyMs: 250, what: 'fwd to post the base lead to Frequency on its own' });
    try {
      await waitFor(() => postFor('coach@stillwater.example'), { timeoutMs: 8000, everyMs: 250, what: 'the copy lead' });
    } catch {
      missing("fwd posted the base flow's lead but never the copy's (the CRM sync does not read copies)");
    }
    const copyPost = postFor('coach@stillwater.example');
    check(copyPost.signed, "the copy's post does not carry a signature that verifies");
    check(copyPost.body?.flow === COPY, `the copy's post names flow ${JSON.stringify(copyPost.body?.flow)}, expected ${COPY}`);
    await waitFor(() => read(copyDir, 'hnt_probe-copy00000001').crm?.status === 'synced', { timeoutMs: 10000, everyMs: 200, what: "the copy's draft to record crm synced" });
    const c = read(copyDir, 'hnt_probe-copy00000001').crm;
    check(c.lead_status === 'open' && /conversations\?id=conv-1$/.test(c.conversation_url ?? ''), `the copy draft's crm: ${JSON.stringify(c)}`);

    // ---- 2. the base flow's lead still names the base flow -----------------------------------------------
    check(postFor('hello@frontporch.example').body?.flow === KEY, `the base post names flow ${JSON.stringify(postFor('hello@frontporch.example').body?.flow)}`);
    await waitFor(() => read(baseDir, 'hnt_probe-base00000001').crm?.status === 'synced', { timeoutMs: 10000, everyMs: 200, what: "the base draft to record crm synced" });

    // ---- 3. a copy's contact-form draft is never posted ---------------------------------------------------
    check(crmPosts().every((x) => x.body?.draft?.tag !== 'hnt_probe-copyform0002'), "a copy's contact-form draft was posted");

    // ---- 4. nothing changed, nothing posted ---------------------------------------------------------------
    const before = crmPosts().length;
    const sync = await http(port, 'POST', `/v1/flows/${KEY}/crm/sync`, token);
    check(sync.status === 200, `a sync answered ${sync.status}: ${sync.body.slice(0, 200)}`);
    check(crmPosts().length === before, 'a sync with nothing changed posted again');
  } finally {
    freq.close();
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
