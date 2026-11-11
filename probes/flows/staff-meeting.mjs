// Probe for FW-C-132 (the Monday staff meeting: one weekly read across the marketing flows, each with one
// number, one win and one ask): `pnpm probe flows/staff-meeting`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token), GET /v1/supervisor/staff-meeting, the archive route
// POST /v1/supervisor/flows/{key}/archive, and draft files the probe writes into
// $FW_HOME/flows/neighborhood-activation/drafts/ before fwd starts (the same files a cycle writes).
//
// The surface this probe expects:
//   GET /v1/supervisor/staff-meeting (CLI token or paired session; none 401) answers { data: { as_of, from,
//     to, reports } } for the 7 days before as_of. reports has one entry per shipped flow whose project
//     category is marketing and that is not archived, in the order GET /v1/supervisor lists flows. Each is
//     { flow, name, number: { label, value }, win, ask }:
//       number: the flow's goal progress when it has a goal, else the drafts sent in the 7 days (label says which).
//       win: null when the flow had no reply in the 7 days, else one plain sentence that names the count.
//       ask: null when nothing waits for the Owner, else one plain sentence that names how many drafts wait.
//     Plain code builds it from rows; no model call, no number that is not counted, and the same rows give
//     the same answer.
//
// Proves, in order:
//   1. The route exists, needs a session, and lists every marketing flow once.
//   2. Numbers, wins and asks are counted from the drafts, and empty flows say nothing rather than guess.
//   3. An archived flow leaves the meeting.
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/staff-meeting';
const KEY = 'neighborhood-activation';
const QUIET = 'local-saturation';
const GONE = 'local-pulse';
const M = '/v1/supervisor/staff-meeting';
const DAY = 86_400_000;

function seedDrafts(home, now) {
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const iso = (days) => new Date(now - days * DAY).toISOString();
  const drafts = [
    { id: 'drf_m1', status: 'handed_off', sent_at: iso(3), replied_at: iso(2) },
    { id: 'drf_m2', status: 'handed_off', sent_at: iso(4), replied_at: iso(1) },
    { id: 'drf_m3', status: 'handed_off', sent_at: iso(2) },
    { id: 'drf_m4', status: 'handed_off', sent_at: iso(5) },
    { id: 'drf_m5', status: 'handed_off', sent_at: iso(20), replied_at: iso(19) },
    { id: 'drf_m6', status: 'waiting_for_owner' },
    { id: 'drf_m7', status: 'waiting_for_owner' },
    { id: 'drf_m8', status: 'waiting_for_owner' },
  ];
  for (const d of drafts) {
    const doc = { created_at: iso(6), channel: 'email', body: 'Hello from the probe.', ...d };
    writeFileSync(join(dir, `${d.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

const marketingFlows = () =>
  readdirSync(join(root, 'flows'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((k) => {
      try {
        readFileSync(join(root, 'flows', k, 'stream.json'));
        return JSON.parse(readFileSync(join(root, 'flows', k, 'project.json'), 'utf8')).category === 'marketing';
      } catch {
        return false;
      }
    });

await probe(NAME, async () => {
  const home = realpathSync(freshHome('staff-meeting'));
  seedDrafts(home, Date.now());
  const f = await startFwd(home);
  try {
    const meet = async () => {
      const r = await api(f.port, 'GET', M, { auth: f.token });
      if (r.status === 404 && /no route/i.test(r.text)) missing(`GET ${M} does not exist (row FW-C-132)`);
      check(r.status === 200, `GET ${M} answered ${r.status}: ${r.text.slice(0, 200)}`);
      return r.json?.data;
    };

    // ---- 1. the route and its list ----------------------------------------------------------------------
    const m = await meet();
    check((await api(f.port, 'GET', M)).status === 401, `GET ${M} without a session was not 401`);
    check(m && typeof m.as_of === 'string' && typeof m.from === 'string' && typeof m.to === 'string', `the meeting has no dates: ${JSON.stringify(m)?.slice(0, 200)}`);
    check(Math.round((Date.parse(m.to) - Date.parse(m.from)) / DAY) === 7, `the meeting covers ${m.from} to ${m.to}, want 7 days`);
    const order = ((await api(f.port, 'GET', '/v1/supervisor', { auth: f.token })).json?.data?.flows ?? []).map((x) => x.key);
    const want = order.filter((k) => marketingFlows().includes(k));
    check(JSON.stringify(m.reports.map((r) => r.flow)) === JSON.stringify(want), `the meeting lists ${m.reports.map((r) => r.flow)}, want ${want}`);

    // ---- 2. counted, not guessed -------------------------------------------------------------------------
    const na = m.reports.find((r) => r.flow === KEY);
    check(na.number?.value === 4 && typeof na.number.label === 'string' && na.number.label.length > 0, `${KEY}'s number: ${JSON.stringify(na.number)}, want 4 sent`);
    check(typeof na.win === 'string' && /\b2\b/.test(na.win), `${KEY}'s win does not name its 2 replies: ${na.win}`);
    check(typeof na.ask === 'string' && /\b3\b/.test(na.ask), `${KEY}'s ask does not name its 3 waiting drafts: ${na.ask}`);
    const quiet = m.reports.find((r) => r.flow === QUIET);
    check(quiet.number?.value === 0 && quiet.win === null && quiet.ask === null, `a flow with no rows reports ${JSON.stringify(quiet)}`);
    for (const r of m.reports) for (const s of [r.win, r.ask]) check(s === null || !s.includes('—'), `${r.flow} uses an em dash: ${s}`);
    const again = await meet();
    check(JSON.stringify(again.reports) === JSON.stringify(m.reports), 'the same rows gave a different meeting');

    // ---- 3. archived flows leave ------------------------------------------------------------------------
    check((await api(f.port, 'POST', `/v1/supervisor/flows/${GONE}/archive`, { auth: f.token, body: {} })).status === 200, `archiving ${GONE} was refused`);
    check(!(await meet()).reports.some((r) => r.flow === GONE), `${GONE} is archived but still reports`);
  } finally {
    await f.stop();
  }
});
