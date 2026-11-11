// Probe for FW-C-113 (S9, the email approval queue: Claude or ChatGPT posts an email draft, the Owner sees
// its facts check beside the text and pastes it into Frequency Email Studio himself):
// `pnpm probe flows/email-queue`. Tier 0.
// Surfaces: the shipped flows/email-queue folder, the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and no
// facts.json, POST /v1/flows/email-queue/drafts { asset, subject, body, audience } with the CLI token, and
// GET /v1/supervisor/flows/email-queue/drafts. The drafts folder is $FW_HOME/flows/email-queue/drafts.
//
// Proves, in order:
//   1. The flow ships off, with the tags utm_source=email, utm_medium=email, utm_campaign=founding, the closed
//      paths /launch, /for/ and /start/host, and audiences that never include all_contacts or imported_contacts.
//      The only dates a draft may name are January 31, 2027 (beta end) and January 1, 2027 (opening day).
//   2. A clean email (tagged live link, January 31 and January 1, 2027, an opted-in audience) is saved as
//      waiting_for_owner on channel email, as a template (it names no single person), with a gate that blocks
//      nothing, and the drafts list shows that gate.
//   3. Each broken email is saved gate_blocked naming its rule: a dash, Midnight, a typed price, a beta date
//      or opening day, a made-up count, a closed link, wrong tags, no link, a host note with no opt-out line
//      (a list whose sender adds no unsubscribe footer), an audience that is not a listed opted-in list.
//   4. Nothing sends: approving a queue draft is refused and no outbox file appears.
//   5. No token answers 401, a bad asset or empty body 400, another flow 404.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, root, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/email-queue';
const KEY = 'email-queue';
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
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 30000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        ok({ status: res.statusCode, body: text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function startFwd(home) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home, FW_VENDOR: 'fake' } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { port, token: readFileSync(tokenPath, 'utf8').trim() };
}

const tag = (path, asset, over = {}) => {
  const u = new URL(`https://frequencylocal.com${path}`);
  const q = { utm_source: 'email', utm_medium: 'email', utm_campaign: 'founding', utm_content: asset, ...over };
  for (const [k, v] of Object.entries(q)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
};
const SIGN = 'Daniel Tyack\nFounder\nfrequencylocal.com';
const PS = "P.S. If you'd rather not get these emails, reply no or unsubscribe and you won't get another.";
const email = (asset, middle, { link = tag('/help/changelog', asset), ps = PS } = {}) =>
  `Hi there!\n\n${middle}\n\nSee what's new: ${link}\n\n${SIGN}${ps ? `\n\n${ps}` : ''}`;
const CLEAN = 'We open on January 1, 2027, and Frequency is free through January 31, 2027.';

await probe(NAME, async () => {
  // ---- 1. the flow ships ------------------------------------------------------------------------------
  const dir = join(root, 'flows', KEY);
  if (!existsSync(join(dir, 'stream.json'))) missing(`flows/${KEY}/stream.json is missing`);
  const stream = JSON.parse(readFileSync(join(dir, 'stream.json'), 'utf8'));
  check(stream.key === KEY && stream.enabled === false, `flows/${KEY}/stream.json must be keyed ${KEY} and ship off`);
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const t = cfg.links ?? {};
  check(t.utm_source === 'email' && t.utm_medium === 'email', `config.json tags ${JSON.stringify(t)}, want email/email`);
  check((t.utm_campaigns ?? []).includes('founding'), 'config.json does not allow utm_campaign=founding');
  for (const p of ['/launch', '/for/', '/start/host'])
    check((cfg.closed_paths ?? []).includes(p), `config.json does not close ${p} (not live yet)`);
  const auds = cfg.audiences ?? [];
  check(auds.length > 0 && auds.every((a) => a.key && a.label && typeof a.unsubscribe_footer === 'boolean'), 'config.json audiences need key, label and unsubscribe_footer');
  for (const bad of ['all_contacts', 'imported_contacts', 'members'])
    check(!auds.some((a) => a.key === bad), `config.json lets a queue email go to ${bad}, a list that did not opt in`);
  const AUD = auds.find((a) => a.unsubscribe_footer)?.key;
  const NOTE = auds.find((a) => !a.unsubscribe_footer)?.key;
  check(AUD && NOTE, 'config.json needs a list with an unsubscribe footer and a personal note list without one');
  const dates = JSON.stringify(cfg.dates ?? []);
  check(/January/.test(dates) && /31/.test(dates) && /2027/.test(dates), 'config.json dates do not hold January 31, 2027');

  const home = freshHome('email-queue');
  try {
    const f = await startFwd(home);
    const path = `/v1/flows/${KEY}/drafts`;
    const post = (body) => http(f.port, 'POST', path, f.token, body);
    const draftsDir = join(home, 'flows', KEY, 'drafts');

    // ---- 2. a clean email waits for the Owner with a passing facts check -----------------------------
    const ok = await post({ asset: 'whats-new', subject: 'See what is new on Frequency', body: email('whats-new', CLEAN), audience: AUD });
    if (ok.status === 404 || ok.status === 405) missing(`POST ${path} answered ${ok.status} (no queue route)`);
    check(ok.status === 200, `a clean email answered ${ok.status}: ${ok.body.slice(0, 400)}`);
    const d = ok.json?.data?.draft;
    check(d?.status === 'waiting_for_owner', `a clean email was stored ${d?.status}: ${JSON.stringify(d?.gate)}`);
    check(d.channel === 'email', `a queue draft has channel ${d.channel}, want email`);
    check(String(d.lead_id).startsWith('template:'), `a queue draft names a person (${d.lead_id}); it is a list email`);
    check(Array.isArray(d.gate?.blocks) && d.gate.blocks.length === 0, `a clean email carries blocks: ${JSON.stringify(d.gate)}`);
    check(existsSync(join(draftsDir, `${d.id}.json`)), `the clean email is not in ${draftsDir}`);
    const list = await http(f.port, 'GET', `/v1/supervisor/flows/${KEY}/drafts`, f.token);
    const listed = (list.json?.data ?? []).find((x) => x.id === d.id);
    check(listed && listed.gate && Array.isArray(listed.gate.blocks), 'the drafts list does not show the facts check');

    // ---- 3. every broken rule is caught -----------------------------------------------------------------
    const cases = [
      ['dash', 'a-dash', email('a-dash', 'Big news \u2014 a lot changed.')],
      ['midnight', 'a-midnight', email('a-midnight', 'Try the Midnight theme on your Space.')],
      ['typed_price', 'a-price', email('a-price', 'The Founding Year is $9 a month.')],
      ['other_date', 'a-date', email('a-date', 'Frequency is free through December 31, 2026.')],
      ['unsourced_number', 'a-count', email('a-count', 'Join 500 hosts who already moved over.')],
      ['closed_link', 'a-closed', email('a-closed', CLEAN, { link: tag('/start/host', 'a-closed') })],
      ['closed_link', 'a-niche', email('a-niche', CLEAN, { link: tag('/for/teacher', 'a-niche') })],
      ['closed_link', 'a-launch', email('a-launch', CLEAN, { link: tag('/launch', 'a-launch') })],
      ['link_tags', 'a-source', email('a-source', CLEAN, { link: tag('/pricing', 'a-source', { utm_source: 'flowweb' }) })],
      ['link_tags', 'a-content', email('a-content', CLEAN, { link: tag('/pricing', 'something-else') })],
      ['no_tagged_link', 'a-nolink', email('a-nolink', CLEAN, { link: 'frequencylocal.com' })],
      ['no_opt_out', 'a-ps', email('a-ps', CLEAN, { ps: '' }), NOTE],
      ['other_date', 'a-preheader', email('a-preheader', CLEAN), AUD, 'Free until December 1.'],
    ];
    for (const [code, asset, body, audience = AUD, preheader] of cases) {
      const r = await post({ asset, subject: 'An update from Frequency', body, audience, ...(preheader ? { preheader } : {}) });
      check(r.status === 200, `the ${code} email answered ${r.status}: ${r.body.slice(0, 300)}`);
      const g = r.json?.data?.draft;
      check(g?.status === 'gate_blocked', `an email breaking ${code} (${asset}) was stored ${g?.status}`);
      check((g.gate?.blocks ?? []).some((b) => b.code === code), `the ${asset} email was blocked for ${JSON.stringify(g.gate?.blocks)}, not ${code}`);
    }
    const aud = await post({ asset: 'a-audience', subject: 'An update', body: email('a-audience', CLEAN), audience: 'all_contacts' });
    check(aud.json?.data?.draft?.status === 'gate_blocked', `an email to all_contacts was stored ${aud.json?.data?.draft?.status}`);
    check((aud.json.data.draft.gate?.blocks ?? []).some((b) => b.code === 'not_opted_in'), 'an email to a list that did not opt in is not blocked not_opted_in');

    // ---- 4. nothing sends ---------------------------------------------------------------------------------
    const ap = await http(f.port, 'POST', `/v1/supervisor/flows/${KEY}/drafts/${d.id}/approve`, f.token, {});
    check(ap.status === 409, `approving a queue email answered ${ap.status}, want 409 (the Owner sends it from Email Studio)`);
    const outbox = join(home, 'outbox', KEY);
    check(!existsSync(outbox) || readdirSync(outbox).length === 0, 'a queue email reached the outbox');

    // ---- 5. token, input and flow ---------------------------------------------------------------------------
    const anon = await http(f.port, 'POST', path, null, { asset: 'x-anon', subject: 's', body: email('x-anon', CLEAN), audience: AUD });
    check(anon.status === 401, `a post without a token answered ${anon.status}, want 401`);
    for (const bad of [{}, { asset: 'Bad Asset!', subject: 's', body: 'b', audience: AUD }, { asset: 'ok-asset', subject: 's', body: '  ', audience: AUD }]) {
      const r = await post(bad);
      check(r.status === 400, `a post with ${JSON.stringify(bad).slice(0, 80)} answered ${r.status}, want 400`);
    }
    const other = await http(f.port, 'POST', '/v1/flows/paid-ads/drafts', f.token, { asset: 'x', subject: 's', body: 'b', audience: AUD });
    check(other.status === 404, `posting to a flow with no email queue answered ${other.status}, want 404`);
  } finally {
    for (const k of kids) await killAndWait(k);
  }
});
