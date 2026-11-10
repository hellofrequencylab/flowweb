// Probe for FW-C-041 (saved event lead hunts in the neighborhood activation flow): `pnpm probe flows/hunts`.
// Tier 0.
// Surfaces: the daemon fwd (one node process on a fresh FW_HOME, with FW_VENDOR=fake and
// FW_FAKE_SCENARIO=hunt_leads so a cycle runs on the fake adapter without a network or keys), the hunt
// routes under /v1/flows/neighborhood-activation/hunts with the CLI token fwd prints, the existing
// do-not-contact and Supervisor routes, the drafts folder $FW_HOME/flows/<key>/drafts/, the outbox
// $FW_HOME/outbox/<key>/, and the database read-only.
// The surface this probe expects:
//   POST /v1/flows/neighborhood-activation/hunts saves a hunt. Body: { name, looking_for, region,
//   areas?, links?, every_days?, max_sends?, build? }. links are pages the Owner wants searched (event
//   listing pages, at most 20, each http or https). It answers 201 with { data: hunt } where hunt has id,
//   name, looking_for, region, areas, links (default []), every_days (default 1), max_sends (default 10, at most 25),
//   build (default false), enabled (true) and last_run_at (null). A bad body answers 400 and saves
//   nothing. GET .../hunts answers { data: [hunt] }. DELETE .../hunts/{id} removes one.
//   POST .../hunts/{id}/run asks for that hunt in the next cycle and fires the flow by hand through
//   the scheduler, so the Supervisor decides it like any fire: { data: { fire_id, outcome, reason? } }.
//   A cycle writes the hunts due in it, with their links, to hunts.json in the cycle folder
//   $FW_HOME/flows/<key>/cycles/<fire>/, so the adapter searches the Owner's pages first. The adapter answers with
//   leads.json there: { leads: [{ hunt_id, event: { title, starts_at, url }, organizer: { name,
//   email, source_url }, subject, body }] }. fwd, not the model, decides which leads get a message:
//   the contact must name the public page it was found on (source_url), must not be on the
//   do-not-contact list, and must not have been drafted for before; at most max_sends per hunt per run.
//   Each kept lead becomes one draft file with hunt_id, to, source_url, event, subject, body and
//   status, and the body ends with the Owner's sign-off, the page the address came from and a one-line
//   opt-out ("reply no"). Without build the body carries the host funnel link with src=hunt; with
//   build it carries the {{claim_url}} slot the sender fills. The run report body gains
//   hunts: [{ id, found, drafted, blocked, not_public, duplicate, capped }].
//   At confirmed Autopilot each draft goes through handOff to the outbox on the frequency channel, its
//   file carrying the lead (hunt_id, to, source_url, event, build), and the draft reads handed_off.
// The fake scenario hunt_leads answers six leads for every hunt in hunts.json: three good ones (a, d,
// f), one whose address is blocked@example.org, one without a source_url, and one that repeats a's
// address.
//
// Proves, in order:
//   1. Hunts need the CLI token (401 without it), a bad hunt (including a link that is not http or
//      https) is refused with 400 and saves nothing, and a good one is saved with its links and
//      defaults and listed.
//   2. Running a hunt at Draft drafts only what the rules allow: a and d (max_sends 2), b blocked by
//      do-not-contact, c dropped as not public, e a duplicate, f capped. Every draft waits for the
//      Owner, ends with the sign-off, its source page and the opt-out line, and carries the funnel
//      link. The cycle folder's hunts.json carries the hunt's links. The hunt records last_run_at.
//      Nothing reaches the outbox.
//   3. Running the same hunt again drafts only f: nobody is written to twice.
//   4. At confirmed Autopilot, a second hunt with build on hands its drafts to the outbox on the
//      frequency channel with the lead attached and the {{claim_url}} slot in the body; those drafts
//      read handed_off and each has one notification.queued event.
//   5. A deleted hunt is gone from the list, and running it answers 404.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, openDbReadonly, probe, root, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/hunts';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/hunts`;
const LINK = 'https://example.com/encinitas/events';
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
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' };
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
  const home = freshHome('hunts');
  try {
    const f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);
    const drafts = join(home, 'flows', KEY, 'drafts');
    const outbox = join(home, 'outbox', KEY);

    async function runHunt(id) {
      const run = await api('POST', `${BASE}/${id}/run`);
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
      const h = Array.isArray(rep.hunts) ? rep.hunts.find((x) => x.id === id) : undefined;
      check(h, `the run report has no hunts entry for ${id}: ${JSON.stringify(rep).slice(0, 300)}`);
      return { fire: rd.fire_id, rep, h };
    }

    // ---- 1. saving hunts -----------------------------------------------------------------------------
    const anon = await http(f.port, 'POST', BASE, null, { name: 'x', looking_for: 'x', region: 'north-county-sd' });
    if (anon.status === 404) missing(`POST ${BASE} answered 404 (no hunt routes)`);
    check(anon.status === 401, `saving a hunt without a token answered ${anon.status}, want 401`);
    for (const bad of [
      { name: 'No region', looking_for: 'sound baths' },
      { name: 'Unknown region', looking_for: 'sound baths', region: 'atlantis' },
      { name: 'Nothing to look for', looking_for: '', region: 'north-county-sd' },
      { name: 'Too many', looking_for: 'sound baths', region: 'north-county-sd', max_sends: 26 },
      { name: 'Bad link', looking_for: 'sound baths', region: 'north-county-sd', links: ['javascript:alert(1)'] },
    ]) {
      const r = await api('POST', BASE, bad);
      check(r.status === 400, `saving "${bad.name}" answered ${r.status}, want 400`);
    }
    check((json(await api('GET', BASE))?.data ?? []).length === 0, 'a refused hunt was saved');
    const made = await api('POST', BASE, {
      name: 'Sound baths in Encinitas',
      looking_for: 'sound baths and breathwork workshops',
      region: 'north-county-sd',
      areas: ['encinitas'],
      links: [LINK],
      max_sends: 2,
    });
    check(made.status === 201, `saving a hunt answered ${made.status}: ${made.body.slice(0, 200)}`);
    const h1 = json(made)?.data;
    check(
      typeof h1?.id === 'string' && h1.every_days === 1 && h1.max_sends === 2 && h1.build === false &&
        h1.enabled === true && h1.last_run_at === null && h1.region === 'north-county-sd' &&
        Array.isArray(h1.links) && h1.links.length === 1 && h1.links[0] === LINK,
      `the saved hunt: ${JSON.stringify(h1)}`,
    );
    const listed = json(await api('GET', BASE))?.data ?? [];
    check(listed.length === 1 && listed[0].id === h1.id, `GET ${BASE}: ${JSON.stringify(listed).slice(0, 200)}`);

    // ---- 2. a run at Draft drafts only what the rules allow -----------------------------------------
    const dnc = await api('POST', `/v1/flows/${KEY}/do-not-contact`, { email: 'blocked@example.org', reason: 'asked not to be contacted' });
    check(dnc.status === 200, `adding an address to do-not-contact answered ${dnc.status}: ${dnc.body.slice(0, 200)}`);
    const en = await api('POST', `/v1/supervisor/flows/${KEY}/enable`);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}`);
    const r1 = await runHunt(h1.id);
    check(
      r1.h.found === 6 && r1.h.drafted === 2 && r1.h.blocked === 1 && r1.h.not_public === 1 &&
        r1.h.duplicate === 1 && r1.h.capped === 1,
      `hunt counts after the first run: ${JSON.stringify(r1.h)}, want found 6, drafted 2, blocked 1, not_public 1, duplicate 1, capped 1`,
    );
    const first = readAll(drafts).filter((d) => d.hunt_id === h1.id);
    check(first.length === 2, `drafts for the hunt: ${first.length}, want 2`);
    for (const d of first) {
      check(d.status === 'waiting_for_owner', `a hunt draft at Draft is ${d.status}, want waiting_for_owner`);
      check(typeof d.to === 'string' && d.to.includes('@') && d.to !== 'blocked@example.org', `draft to: ${d.to}`);
      check(typeof d.source_url === 'string' && /^https?:\/\//.test(d.source_url), `draft source_url: ${d.source_url}`);
      check(d.event && typeof d.event.url === 'string', `draft event: ${JSON.stringify(d.event)}`);
      const body = String(d.body ?? '');
      check(body.includes(d.source_url), 'a hunt draft does not say which public page the address came from');
      check(/reply "?no"?/i.test(body), 'a hunt draft has no one-line opt-out ("reply no")');
      check(/\/start\/host\?[^\s]*src=hunt/.test(body), 'a hunt draft without build has no host funnel link with src=hunt');
      check(!body.includes('{{claim_url}}'), 'a hunt without build carries a claim slot');
    }
    const cycleHunts = join(home, 'flows', KEY, 'cycles', r1.fire.replace(/[^A-Za-z0-9_-]/g, '_'), 'hunts.json');
    check(existsSync(cycleHunts), 'the cycle folder has no hunts.json');
    const due = JSON.parse(readFileSync(cycleHunts, 'utf8'));
    const dueH = (Array.isArray(due) ? due : (due.hunts ?? [])).find((x) => x.id === h1.id);
    check(dueH && Array.isArray(dueH.links) && dueH.links.includes(LINK), `hunts.json for the cycle: ${JSON.stringify(due).slice(0, 300)}`);
    const after1 = (json(await api('GET', BASE))?.data ?? []).find((x) => x.id === h1.id);
    check(typeof after1?.last_run_at === 'string', `the hunt did not record last_run_at: ${JSON.stringify(after1)}`);
    check(filesIn(outbox).length === 0, 'a hunt at Draft wrote to the outbox');

    // ---- 3. nobody is written to twice ----------------------------------------------------------------
    const r2 = await runHunt(h1.id);
    check(r2.h.drafted === 1 && r2.h.duplicate >= 3, `hunt counts on the second run: ${JSON.stringify(r2.h)}, want drafted 1 (f) and the rest duplicates`);
    const tos = readAll(drafts).filter((d) => d.hunt_id === h1.id).map((d) => d.to);
    check(new Set(tos).size === tos.length && tos.length === 3, `addresses drafted for across two runs: ${JSON.stringify(tos)}`);

    // ---- 4. Autopilot hands hunt drafts to the outbox --------------------------------------------------
    const ask = await api('POST', `/v1/supervisor/flows/${KEY}/dial`, { stop: 'autopilot' });
    const hash = json(ask)?.error?.details?.confirm_hash ?? json(ask)?.error?.confirm_hash;
    check(ask.status === 409 && typeof hash === 'string', `asking for Autopilot answered ${ask.status}: ${ask.body.slice(0, 200)}`);
    const ok = await api('POST', `/v1/supervisor/flows/${KEY}/dial`, { stop: 'autopilot', confirm: hash });
    check(ok.status === 200, `confirming Autopilot answered ${ok.status}: ${ok.body.slice(0, 200)}`);
    const h2 = json(
      await api('POST', BASE, { name: 'Yoga in Vista', looking_for: 'yoga classes', region: 'north-county-sd', build: true, max_sends: 3 }),
    )?.data;
    check(h2?.build === true, `the build hunt: ${JSON.stringify(h2)}`);
    const r3 = await runHunt(h2.id);
    check(r3.h.drafted === 3, `the build hunt drafted ${r3.h.drafted}, want 3`);
    const items = readAll(outbox);
    check(items.length === 3, `outbox files at Autopilot: ${items.length}, want 3`);
    for (const it of items) {
      check(it.channel === 'frequency', `an outbox item went to ${it.channel}, want frequency`);
      const lead = it.lead ?? it.meta?.lead ?? it.meta;
      check(
        lead && lead.hunt_id === h2.id && lead.build === true && typeof lead.to === 'string' && typeof lead.source_url === 'string',
        `an outbox item does not carry its lead: ${JSON.stringify(it).slice(0, 300)}`,
      );
      check(String(it.body).includes('{{claim_url}}'), 'a build hunt item has no {{claim_url}} slot');
      check(/reply "?no"?/i.test(String(it.body)), 'an outbox item has no opt-out line');
    }
    const handed = readAll(drafts).filter((d) => d.hunt_id === h2.id);
    check(handed.length === 3 && handed.every((d) => d.status === 'handed_off'), `build hunt drafts: ${JSON.stringify(handed.map((d) => d.status))}, want 3 handed_off`);
    const queued = await rows(home, "SELECT payload FROM events WHERE type = 'notification.queued'");
    check(queued.length === 3, `notification.queued events: ${queued.length}, want 3`);

    // ---- 5. deleting a hunt ---------------------------------------------------------------------------
    const del = await api('DELETE', `${BASE}/${h1.id}`);
    check(del.status === 200, `deleting a hunt answered ${del.status}`);
    const left = (json(await api('GET', BASE))?.data ?? []).map((x) => x.id);
    check(left.length === 1 && left[0] === h2.id, `hunts after the delete: ${JSON.stringify(left)}`);
    const gone = await api('POST', `${BASE}/${h1.id}/run`);
    check(gone.status === 404, `running a deleted hunt answered ${gone.status}, want 404`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
