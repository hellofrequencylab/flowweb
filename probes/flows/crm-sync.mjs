// Probe for FW-C-065 (every email lead a flow drafts to can be followed in Frequency's CRM):
// `pnpm probe flows/crm-sync`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME, a stand-in Frequency on 127.0.0.1 named by
// FW_FREQUENCY_URL, the credential file $FW_HOME/creds/crd_frequencyoutcomes, the drafts folder
// $FW_HOME/flows/neighborhood-activation/drafts/, and the routes under /v1/supervisor and
// /v1/flows/neighborhood-activation with the CLI token fwd prints.
// The surface this probe expects:
//   fwd POSTs one draft's whole state to <Frequency>/api/webhooks/flowweb-crm, signed with the secret behind
//   crd_frequencyoutcomes as hex HMAC-SHA256 of `${x-flowweb-timestamp}.${body}` in x-flowweb-signature
//   (Frequency LIVE-2256): { flow, lead: { email, name, org, source_url, region, hunt },
//   draft: { tag, subject, body, created_at, sent_at, replied_at, declined_at } }.
//   It posts soon after it starts (with the daily outcomes pull), right after each mark, and on
//   POST /v1/flows/neighborhood-activation/crm/sync -> 200 { data: { synced, failed } }.
//   Only drafts to an email address are posted; a contact-form or social draft never is, and neither is a
//   draft the Owner rejected without sending. A draft whose marks have not changed since its last good sync
//   is not posted again the same day. Frequency's answer is written onto the draft file as
//   crm { status: 'synced' | 'off' | 'failed', at, lead_status?, signed_up?, conversation_url?, error? },
//   and GET /v1/supervisor/flows/{key}/drafts shows it. A Frequency that is down never fails a mark: the
//   mark answers 200 and the draft records crm.status 'failed'.
//
// Proves, in order:
//   1. Soon after it starts, fwd posts the email draft, signed, and records crm synced with Frequency's
//      lead_status and conversation_url; the form draft and the rejected draft are never posted.
//   2. A sync with nothing changed posts nothing.
//   3. Marking the draft sent posts it again with sent_at, and the draft shows lead_status waiting.
//   4. GET .../drafts shows crm on the draft.
//   5. With Frequency down, marking replied still answers 200 and the draft records crm failed.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/crm-sync';
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
    created_at: '2026-11-10T08:00:00.000Z',
    ...extra,
  };
}

await probe(NAME, async () => {
  const home = freshHome('crm-sync');
  const freq = await fakeFrequency();
  try {
    const dir = join(home, 'flows', KEY, 'drafts');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const put = (d) => writeFileSync(join(dir, `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
    put(draft('hnt_probe-email0000001', { to: 'hello@frontporch.example', send_via: 'email' }));
    put(draft('hnt_probe-form00000002', { to: null, contact_url: 'https://form.example/contact', send_via: 'contact_form' }));
    put(draft('hnt_probe-rejected0003', { to: 'nope@other.example', status: 'rejected', rejected_at: '2026-11-10T09:00:00.000Z' }));
    const read = (id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
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

    // ---- 1. fwd posts the email lead on its own ----------------------------------------------------------
    await waitFor(() => crmPosts().length > 0, { timeoutMs: 20000, everyMs: 250, what: 'fwd to post a lead to Frequency on its own' });
    await waitFor(() => read('hnt_probe-email0000001').crm?.status === 'synced', { timeoutMs: 10000, everyMs: 200, what: 'the draft to record crm synced' });
    const first = crmPosts()[0];
    check(first.signed, 'the post fwd sent does not carry a signature that verifies');
    check(first.body?.lead?.email === 'hello@frontporch.example', `the post names lead ${JSON.stringify(first.body?.lead)}`);
    check(first.body?.draft?.tag === 'hnt_probe-email0000001' && typeof first.body?.draft?.body === 'string', `the post's draft: ${JSON.stringify(first.body?.draft).slice(0, 200)}`);
    const emails = crmPosts().map((x) => x.body?.lead?.email);
    check(!emails.includes('nope@other.example'), 'a draft the Owner rejected without sending was posted');
    check(crmPosts().every((x) => x.body?.draft?.tag !== 'hnt_probe-form00000002'), 'a contact-form draft was posted');
    const c1 = read('hnt_probe-email0000001').crm;
    check(c1.lead_status === 'open' && /conversations\?id=conv-1$/.test(c1.conversation_url ?? ''), `the draft's crm: ${JSON.stringify(c1)}`);

    // ---- 2. nothing changed, nothing posted ----------------------------------------------------------------
    const before = crmPosts().length;
    const sync = await http(port, 'POST', `/v1/flows/${KEY}/crm/sync`, token);
    if (sync.status === 404 || sync.status === 405) missing(`POST /v1/flows/${KEY}/crm/sync answered ${sync.status} (no sync route)`);
    check(sync.status === 200, `a sync answered ${sync.status}: ${sync.body.slice(0, 200)}`);
    check(crmPosts().length === before, 'a sync with nothing changed posted again');

    // ---- 3. a mark posts again --------------------------------------------------------------------------
    const sup = `/v1/supervisor/flows/${KEY}/drafts`;
    const m = await http(port, 'POST', `${sup}/hnt_probe-email0000001/mark`, token, { outcome: 'sent' });
    check(m.status === 200, `marking the draft sent answered ${m.status}: ${m.body.slice(0, 200)}`);
    await waitFor(() => crmPosts().some((x) => typeof x.body?.draft?.sent_at === 'string'), { timeoutMs: 10000, everyMs: 200, what: 'fwd to post the sent mark' });
    await waitFor(() => read('hnt_probe-email0000001').crm?.lead_status === 'waiting', { timeoutMs: 10000, everyMs: 200, what: 'the draft to record lead_status waiting' });

    // ---- 4. the drafts route shows it ---------------------------------------------------------------------
    const list = JSON.parse((await http(port, 'GET', sup, token)).body)?.data;
    const shown = (list?.drafts ?? list ?? []).find?.((x) => x.id === 'hnt_probe-email0000001');
    check(shown?.crm?.status === 'synced' && shown.crm.lead_status === 'waiting', `GET drafts shows crm ${JSON.stringify(shown?.crm)}`);

    // ---- 5. Frequency down never fails a mark ----------------------------------------------------------------
    freq.state.status = 500;
    const r = await http(port, 'POST', `${sup}/hnt_probe-email0000001/mark`, token, { outcome: 'replied' });
    check(r.status === 200, `marking replied with Frequency down answered ${r.status}`);
    await waitFor(() => read('hnt_probe-email0000001').crm?.status === 'failed', { timeoutMs: 10000, everyMs: 200, what: 'the draft to record crm failed' });
    check(typeof read('hnt_probe-email0000001').replied_at === 'string', 'the mark was lost when Frequency was down');
  } finally {
    freq.close();
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
