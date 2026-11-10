// Probe for FW-C-054 (each draft link names its draft, and the Owner marks what happened to a draft):
// `pnpm probe flows/draft-outcome`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hunt_reach, the
// hunt routes under /v1/flows/neighborhood-activation/hunts and the Owner controls under /v1/supervisor
// with the CLI token fwd prints, the drafts folder $FW_HOME/flows/<key>/drafts/, the flow's state.json,
// and `fw supervisor mark <flow> <id> <outcome> --json` (FW_PORT naming fwd's port).
// The surface this probe expects:
//   Every draft file carries tag: the draft id in lower case, anything outside a-z 0-9 _ - made a dash,
//   at most 48 characters (Frequency's slug rule). Every link in the draft body to the offer's site
//   (frequencylocal.com) that carries utm_source=flowweb also carries utm_content=<tag>.
//   POST /v1/supervisor/flows/{key}/drafts/{id}/mark  { outcome: 'sent' | 'replied' | 'declined' }
//        -> 200 { data: { id, status, sent_at?, replied_at?, declined_at? } }  (CLI token)
//        -> 400 for any other outcome, 404 for an unknown draft, 409 rejected for a rejected draft
//   replied and declined also stamp sent_at when it is missing. declined puts the draft's address (or its
//   contact page when it has no address) on the flow's do-not-contact list, because "no" is an opt-out.
//   The status a draft had (waiting_for_owner, handed_off) is unchanged by a mark.
//
// Proves, in order:
//   1. Every hunt draft has a well-formed tag, and its Frequency link carries utm_campaign=<hunt id> and
//      utm_content=<tag>.
//   2. Marking needs the CLI token (401 without).
//   3. sent stamps sent_at and keeps the status; replied stamps replied_at and keeps sent_at.
//   4. A bad outcome answers 400, an unknown draft 404, and neither changes anything.
//   5. declined on the email draft stamps declined_at and puts its address on do-not-contact.
//   6. A rejected draft cannot be marked sent (409 rejected).
//   7. `fw supervisor mark <flow> <id> sent --json` marks a draft the same way.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, fwJson, killAndWait, missing, openDbReadonly, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/draft-outcome';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/hunts`;
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

async function startFwd(home) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_reach' };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function rows(home, sql, ...params) {
  const db = await openDbReadonly(home);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const reports = async (home) =>
  (await rows(home, "SELECT body FROM status_reports WHERE kind = 'run' ORDER BY created_at")).map((r) =>
    JSON.parse(r.body),
  );

const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []);
const readAll = (dir) => filesIn(dir).map((x) => JSON.parse(readFileSync(join(dir, x), 'utf8')));

await probe(NAME, async () => {
  const home = freshHome('draft-outcome');
  try {
    const f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);
    const sup = `/v1/supervisor/flows/${KEY}`;
    const draftsDir = join(home, 'flows', KEY, 'drafts');

    check((await api('POST', `${sup}/enable`)).status === 200, `enabling ${KEY} failed`);
    const made = await api('POST', BASE, { name: 'Community events', looking_for: 'community events', region: 'north-county-sd' });
    check(made.status === 201, `saving a hunt answered ${made.status}: ${made.body.slice(0, 200)}`);
    const hunt = json(made).data;
    const run = await api('POST', `${BASE}/${hunt.id}/run`);
    const fireId = json(run)?.data?.fire_id;
    check(run.status === 200 && fireId, `running the hunt answered ${run.status}: ${run.body.slice(0, 200)}`);
    await waitFor(async () => (await reports(home)).some((b) => b.fire_id === fireId), {
      timeoutMs: 30000,
      everyMs: 250,
      what: 'the hunt cycle to write its run report',
    });
    const mine = readAll(draftsDir).filter((d) => d.hunt_id === hunt.id);
    check(mine.length === 3, `drafts for the hunt: ${mine.length}, want 3`);

    // ---- 1. every link names its draft --------------------------------------------------------------
    if (mine.every((d) => d.tag === undefined)) missing('drafts carry no tag');
    for (const d of mine) {
      const want = d.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
      check(d.tag === want && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(d.tag), `draft ${d.id} has tag ${d.tag}, want ${want}`);
      const links = String(d.body).match(/https?:\/\/[^\s)]+/g) ?? [];
      const ours = links.map((l) => new URL(l)).filter((u) => u.hostname.endsWith('frequencylocal.com'));
      check(ours.length > 0, `draft ${d.id} has no Frequency link: ${String(d.body).slice(0, 200)}`);
      for (const u of ours) {
        check(u.searchParams.get('utm_source') === 'flowweb', `a link in ${d.id} lost utm_source: ${u}`);
        check(u.searchParams.get('utm_campaign') === hunt.id, `a link in ${d.id} has utm_campaign ${u.searchParams.get('utm_campaign')}`);
        check(u.searchParams.get('utm_content') === d.tag, `a link in ${d.id} has utm_content ${u.searchParams.get('utm_content')}, want ${d.tag}`);
      }
    }
    const email = mine.find((d) => d.send_via === 'email');
    const form = mine.find((d) => d.send_via === 'contact_form');
    const social = mine.find((d) => d.send_via === 'social_dm');
    check(email && form && social, `want an email, a contact_form and a social_dm draft: ${JSON.stringify(mine.map((d) => d.send_via))}`);
    const mark = (id, outcome, token = f.token) => http(f.port, 'POST', `${sup}/drafts/${id}/mark`, token, { outcome });
    const list = async () => json(await api('GET', `${sup}/drafts`))?.data ?? [];
    const one = async (id) => (await list()).find((x) => x.id === id);

    // ---- 2. the token is needed ---------------------------------------------------------------------
    const anon = await mark(form.id, 'sent', null);
    if (anon.status === 404 || anon.status === 405) missing(`POST ${sup}/drafts/{id}/mark answered ${anon.status} (no mark route)`);
    check(anon.status === 401, `marking without a token answered ${anon.status}, want 401`);

    // ---- 3. sent, then replied ----------------------------------------------------------------------
    const s = await mark(form.id, 'sent');
    check(s.status === 200, `marking ${form.id} sent answered ${s.status}: ${s.body.slice(0, 200)}`);
    const afterSent = await one(form.id);
    check(typeof afterSent?.sent_at === 'string' && !Number.isNaN(Date.parse(afterSent.sent_at)), `after sent: ${JSON.stringify(afterSent).slice(0, 200)}`);
    check(afterSent.status === 'waiting_for_owner', `a mark changed the status to ${afterSent.status}`);
    const r = await mark(form.id, 'replied');
    check(r.status === 200, `marking ${form.id} replied answered ${r.status}`);
    const afterReply = await one(form.id);
    check(typeof afterReply?.replied_at === 'string' && afterReply.sent_at === afterSent.sent_at, `after replied: ${JSON.stringify(afterReply).slice(0, 200)}`);

    // ---- 4. bad marks change nothing ----------------------------------------------------------------
    for (const bad of ['opened', '', 7]) {
      const b = await http(f.port, 'POST', `${sup}/drafts/${social.id}/mark`, f.token, { outcome: bad });
      check(b.status === 400, `marking with outcome ${JSON.stringify(bad)} answered ${b.status}, want 400`);
    }
    check((await mark('nope-not-a-draft', 'sent')).status === 404, 'marking an unknown draft did not answer 404');
    check((await one(social.id))?.sent_at === undefined, 'a refused mark stamped sent_at');

    // ---- 5. declined is an opt-out ------------------------------------------------------------------
    const dec = await mark(email.id, 'declined');
    check(dec.status === 200, `marking ${email.id} declined answered ${dec.status}: ${dec.body.slice(0, 200)}`);
    const afterDec = await one(email.id);
    check(typeof afterDec?.declined_at === 'string' && typeof afterDec.sent_at === 'string', `after declined: ${JSON.stringify(afterDec).slice(0, 200)}`);
    const state = JSON.parse(readFileSync(join(home, 'flows', KEY, 'state.json'), 'utf8'));
    const dnc = (state.do_not_contact ?? []).map((x) => String(x).toLowerCase());
    check(dnc.includes(String(email.to).toLowerCase()), `declined did not put ${email.to} on do-not-contact: ${JSON.stringify(dnc)}`);

    // ---- 6. a rejected draft cannot be marked sent ---------------------------------------------------
    check((await api('POST', `${sup}/drafts/${social.id}/reject`)).status === 200, `rejecting ${social.id} failed`);
    const rej = await mark(social.id, 'sent');
    const why = String(json(rej)?.error?.reason ?? json(rej)?.error?.message ?? json(rej)?.error?.code ?? '');
    check(rej.status === 409 && why.includes('rejected'), `marking a rejected draft sent answered ${rej.status} ${rej.body.slice(0, 200)}, want 409 rejected`);

    // ---- 7. the CLI marks too -----------------------------------------------------------------------
    const more = json(await api('POST', BASE, { name: 'Markets', looking_for: 'markets', region: 'north-county-sd' }))?.data;
    const run2 = await api('POST', `${BASE}/${more.id}/run`);
    const fire2 = json(run2)?.data?.fire_id;
    await waitFor(async () => (await reports(home)).some((b) => b.fire_id === fire2), { timeoutMs: 30000, everyMs: 250, what: 'the second hunt cycle' });
    const target = readAll(draftsDir).find((d) => d.hunt_id === more.id);
    check(target, 'the second hunt wrote no draft');
    const cli = fwJson(['supervisor', 'mark', KEY, target.id, 'sent'], { home, env: { FW_PORT: String(f.port) } });
    check(cli.status === 0, `fw supervisor mark exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
    check(typeof (await one(target.id))?.sent_at === 'string', 'fw supervisor mark did not stamp sent_at');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
