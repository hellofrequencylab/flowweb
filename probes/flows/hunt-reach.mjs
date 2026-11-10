// Probe for FW-C-050 (hunts skip organizers in the EU, the UK and Canada, and label each draft with how
// to send it): `pnpm probe flows/hunt-reach`. Tier 0.
// Surfaces: the daemon fwd (one node process on a fresh FW_HOME, with FW_VENDOR=fake and
// FW_FAKE_SCENARIO=hunt_reach), the hunt routes under /v1/flows/neighborhood-activation/hunts with the
// CLI token fwd prints, the Supervisor enable and dial routes, the drafts folder
// $FW_HOME/flows/<key>/drafts/, the outbox $FW_HOME/outbox/<key>/, and the database read-only.
// The surface this probe expects:
//   leads.json leads may carry event.country and organizer.country (two-letter codes), and
//   organizer.contact_via (email, form, social or platform) with organizer.contact_url for the last
//   three; a form, social or platform lead needs no email. fwd drops, as restricted, a lead whose event
//   or organizer country is in the EU or EEA, the UK (GB) or Canada (CA), or whose email domain,
//   contact_url, source_url or event url ends in one of their country domains or .eu. The run report's
//   hunts entry gains restricted. Each kept draft carries send_via (email, contact_form, social_dm or
//   platform_message) and send_how, one sentence that names the address or the page to send it on; a
//   contact_url draft carries contact_url. At confirmed Autopilot only send_via email drafts go to the
//   outbox; the others stay waiting_for_owner.
// The fake scenario hunt_reach answers eight leads for every hunt in hunts.json:
//   a  email, US                                   -> email draft
//   b  email, event.country CA                     -> restricted
//   c  email at an example.de address              -> restricted
//   d  email, organizer.country FR                 -> restricted
//   e  contact form at example.com, no email       -> contact_form draft
//   f  Instagram profile, no email                 -> social_dm draft
//   g  email, organizer.country GB                 -> restricted
//   h  contact form at example.ca                  -> restricted
//
// Proves, in order:
//   1. A run at Draft drafts a, e and f only, counts 5 restricted, and no draft names a restricted
//      organizer, page or address.
//   2. a reads send_via email with its address in send_how; e reads contact_form and f social_dm, each
//      with its contact_url in send_how and no email. Every draft names its source page and has the
//      "reply no" opt-out. Nothing reaches the outbox.
//   3. At confirmed Autopilot, a second hunt hands only its email draft to the outbox; its form and
//      social drafts stay waiting_for_owner.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, openDbReadonly, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/hunt-reach';
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
  const home = freshHome('hunt-reach');
  try {
    const f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);
    const drafts = join(home, 'flows', KEY, 'drafts');
    const outbox = join(home, 'outbox', KEY);

    async function runHunt(id) {
      const run = await api('POST', `${BASE}/${id}/run`);
      if (run.status === 404) missing(`POST ${BASE}/${id}/run answered 404`);
      check(run.status === 200, `running hunt ${id} answered ${run.status}: ${run.body.slice(0, 200)}`);
      const rd = json(run)?.data;
      check(rd?.outcome === 'fired', `running hunt ${id}: outcome ${rd?.outcome} (${rd?.reason ?? ''}), want fired`);
      let rep;
      await waitFor(
        async () => {
          rep = (await reports(home)).find((b) => b.fire_id === rd.fire_id);
          return rep !== undefined;
        },
        { timeoutMs: 30000, everyMs: 250, what: `the cycle for hunt ${id} to write its run report` },
      );
      if (/unknown fake scenario/i.test(JSON.stringify(rep))) missing('the fake adapter has no hunt_reach scenario');
      const h = Array.isArray(rep.hunts) ? rep.hunts.find((x) => x.id === id) : undefined;
      check(h, `the run report has no hunts entry for ${id}: ${JSON.stringify(rep).slice(0, 300)}`);
      return h;
    }

    const en = await api('POST', `/v1/supervisor/flows/${KEY}/enable`);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}`);
    const made = await api('POST', BASE, {
      name: 'Community events',
      looking_for: 'community events',
      region: 'north-county-sd',
      max_sends: 10,
    });
    check(made.status === 201, `saving a hunt answered ${made.status}: ${made.body.slice(0, 200)}`);
    const h1 = json(made)?.data;

    // ---- 1. restricted leads get no draft -------------------------------------------------------------
    const c1 = await runHunt(h1.id);
    if (c1.restricted === undefined) missing(`the run report's hunts entry has no restricted count: ${JSON.stringify(c1)}`);
    check(
      c1.found === 8 && c1.drafted === 3 && c1.restricted === 5,
      `hunt counts: ${JSON.stringify(c1)}, want found 8, drafted 3, restricted 5`,
    );
    const mine = readAll(drafts).filter((d) => d.hunt_id === h1.id);
    check(mine.length === 3, `drafts for the hunt: ${mine.length}, want 3`);
    for (const d of mine) {
      const k = String(d.event?.url ?? '').split('/').pop();
      const where = [d.to, d.contact_url, d.source_url, d.event?.url].filter(Boolean).join(' ');
      check(['a', 'e', 'f'].includes(k) && !/\.(de|ca)\b/.test(where), `a restricted organizer got a draft: ${where}`);
    }

    // ---- 2. each draft says how to send it ------------------------------------------------------------
    const by = Object.fromEntries(mine.map((d) => [d.send_via, d]));
    if (mine.every((d) => d.send_via === undefined)) missing('hunt drafts carry no send_via');
    const email = by.email;
    check(email && typeof email.to === 'string' && email.to.includes('@'), `the email draft: ${JSON.stringify(email ?? null).slice(0, 300)}`);
    check(typeof email.send_how === 'string' && email.send_how.includes(email.to), `the email draft's send_how does not name ${email.to}: ${email.send_how}`);
    for (const via of ['contact_form', 'social_dm']) {
      const d = by[via];
      check(d, `no ${via} draft among ${JSON.stringify(mine.map((x) => x.send_via))}`);
      check(typeof d.contact_url === 'string' && /^https:\/\//.test(d.contact_url), `the ${via} draft's contact_url: ${d.contact_url}`);
      check(!d.to, `the ${via} draft has an address: ${d.to}`);
      check(typeof d.send_how === 'string' && d.send_how.includes(d.contact_url), `the ${via} draft's send_how does not name its page: ${d.send_how}`);
    }
    check(/instagram\.com/.test(by.social_dm.contact_url), `the social_dm draft's page: ${by.social_dm.contact_url}`);
    for (const d of mine) {
      check(d.status === 'waiting_for_owner', `a draft at Draft is ${d.status}, want waiting_for_owner`);
      const body = String(d.body ?? '');
      check(typeof d.source_url === 'string' && body.includes(d.source_url), `a ${d.send_via} draft does not name its source page`);
      check(/reply "?no"?/i.test(body), `a ${d.send_via} draft has no "reply no" opt-out`);
    }
    check(filesIn(outbox).length === 0, 'a hunt at Draft wrote to the outbox');

    // ---- 3. Autopilot hands only email drafts to the outbox --------------------------------------------
    const ask = await api('POST', `/v1/supervisor/flows/${KEY}/dial`, { stop: 'autopilot' });
    const hash = json(ask)?.error?.details?.confirm_hash ?? json(ask)?.error?.confirm_hash;
    check(ask.status === 409 && typeof hash === 'string', `asking for Autopilot answered ${ask.status}: ${ask.body.slice(0, 200)}`);
    const ok = await api('POST', `/v1/supervisor/flows/${KEY}/dial`, { stop: 'autopilot', confirm: hash });
    check(ok.status === 200, `confirming Autopilot answered ${ok.status}: ${ok.body.slice(0, 200)}`);
    const h2 = json(await api('POST', BASE, { name: 'Markets', looking_for: 'markets', region: 'north-county-sd' }))?.data;
    const c2 = await runHunt(h2.id);
    check(c2.drafted === 3 && c2.restricted === 5, `the Autopilot hunt counts: ${JSON.stringify(c2)}`);
    const items = readAll(outbox);
    check(items.length === 1, `outbox files at Autopilot: ${items.length}, want 1 (the email draft only)`);
    const lead = items[0]?.lead ?? items[0]?.meta?.lead ?? items[0]?.meta;
    check(lead && typeof lead.to === 'string' && lead.to.includes('@'), `the outbox item: ${JSON.stringify(items[0]).slice(0, 300)}`);
    const second = readAll(drafts).filter((d) => d.hunt_id === h2.id);
    const st = Object.fromEntries(second.map((d) => [d.send_via, d.status]));
    check(
      st.email === 'handed_off' && st.contact_form === 'waiting_for_owner' && st.social_dm === 'waiting_for_owner',
      `draft statuses at Autopilot: ${JSON.stringify(st)}, want email handed_off and the others waiting_for_owner`,
    );
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
