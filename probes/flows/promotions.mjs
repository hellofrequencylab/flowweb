// Probe for FW-C-141 (promotion cards the Owner approves when a flow earns the next dial stop, automatic
// demotion, and badges earned only from real rows): `pnpm probe flows/promotions`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/daemon/src/game/promotions.ts and packages/daemon/src/game/badges.ts (pure), a real fwd
// on a fresh FW_HOME (CLI token), GET /v1/supervisor/promotions, GET /v1/game/badges, and draft files the
// probe writes into $FW_HOME/flows/neighborhood-activation/drafts/ before fwd starts.
//
// The surface this probe expects:
//   promotionFor({ dial, days_at_dial, approved, rejected, bad_sends }) is pure and answers { to, why } or null:
//     draft to copilot after 14 days at Draft with at least 20 approved and at most 10% rejected;
//     copilot to autopilot after 30 days at Copilot with 0 bad sends; autopilot never promotes.
//     A bad send is a sent draft whose person asked not to be contacted, or that the Owner marked a regret.
//   demotionFor({ dial, bad_sends }) is pure: any bad send moves autopilot to copilot and copilot to draft;
//     draft stays (null). Demotion is applied by fwd without asking, and says so in an event; promotion is
//     only ever a card.
//   badges(facts) is pure. facts is { first_reply, rsvps, paid_spaces, clean_weeks, cheapest } (first_reply a
//     draft id or null; clean_weeks the weeks with zero stalls; cheapest { flow, usd_per_result } or null).
//     It answers the five badges in this order, each { id, label, earned, evidence }: first_reply,
//     ten_rsvps, first_paid_space, zero_stalls_week, cheapest_win. evidence names the rows behind an earned
//     badge and is [] when it is not earned.
//   GET /v1/supervisor/promotions (CLI token or paired session; none 401) lists [{ flow, from, to, why }]
//     for flows that meet a bar now. GET /v1/game/badges answers badges() for this home's rows.
//
// Proves, in order:
//   1. The promotion and demotion bars.
//   2. Badges are earned only with evidence.
//   3. A fresh fwd has no promotion and no badge; one replied draft earns First Reply with that draft as
//      its evidence.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/promotions';
const KEY = 'neighborhood-activation';
const BADGES = ['first_reply', 'ten_rsvps', 'first_paid_space', 'zero_stalls_week', 'cheapest_win'];

async function load(rel, fn) {
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, rel)).href);
  } catch {
    missing(`${rel} does not exist (row FW-C-141)`);
  }
  if (typeof mod[fn] !== 'function') missing(`${rel} does not export ${fn} (row FW-C-141)`);
  return mod;
}

await probe(NAME, async () => {
  // ---- 1. promotion and demotion bars ------------------------------------------------------------------
  const pr = await load('packages/daemon/src/game/promotions.ts', 'promotionFor');
  if (typeof pr.demotionFor !== 'function') missing('promotions.ts does not export demotionFor (row FW-C-141)');
  const up = (x) => pr.promotionFor({ dial: 'draft', days_at_dial: 0, approved: 0, rejected: 0, bad_sends: 0, ...x });
  let p = up({ days_at_dial: 14, approved: 20, rejected: 2 });
  check(p?.to === 'copilot' && typeof p.why === 'string' && p.why.length > 0, `14 days, 20 approved, 2 rejected: ${JSON.stringify(p)}`);
  check(up({ days_at_dial: 13, approved: 20, rejected: 0 }) === null, '13 days at Draft was promoted');
  check(up({ days_at_dial: 14, approved: 19, rejected: 0 }) === null, '19 approved was promoted');
  check(up({ days_at_dial: 14, approved: 20, rejected: 3 }) === null, '3 of 23 rejected (13%) was promoted');
  p = up({ dial: 'copilot', days_at_dial: 30 });
  check(p?.to === 'autopilot', `30 clean days at Copilot: ${JSON.stringify(p)}`);
  check(up({ dial: 'copilot', days_at_dial: 29 }) === null, '29 days at Copilot was promoted');
  check(up({ dial: 'copilot', days_at_dial: 60, bad_sends: 1 }) === null, 'a bad send at Copilot was promoted');
  check(up({ dial: 'autopilot', days_at_dial: 400, approved: 900 }) === null, 'Autopilot was promoted');
  check(pr.demotionFor({ dial: 'autopilot', bad_sends: 1 }) === 'copilot', 'a bad send at Autopilot did not demote to Copilot');
  check(pr.demotionFor({ dial: 'copilot', bad_sends: 1 }) === 'draft', 'a bad send at Copilot did not demote to Draft');
  check(pr.demotionFor({ dial: 'draft', bad_sends: 3 }) === null, 'Draft was demoted');
  check(pr.demotionFor({ dial: 'autopilot', bad_sends: 0 }) === null, 'a clean Autopilot flow was demoted');

  // ---- 2. badges need evidence -------------------------------------------------------------------------
  const bm = await load('packages/daemon/src/game/badges.ts', 'badges');
  const none = bm.badges({ first_reply: null, rsvps: 9, paid_spaces: 0, clean_weeks: [], cheapest: null });
  check(JSON.stringify(none.map((b) => b.id)) === JSON.stringify(BADGES), `badges are ${none.map((b) => b.id)}, want ${BADGES}`);
  check(none.every((b) => b.earned === false && Array.isArray(b.evidence) && b.evidence.length === 0), `with nothing real a badge is earned: ${JSON.stringify(none)}`);
  check(none.every((b) => typeof b.label === 'string' && b.label.length > 0), 'a badge has no label');
  const all = bm.badges({ first_reply: 'drf_1', rsvps: 10, paid_spaces: 1, clean_weeks: ['2026-W45'], cheapest: { flow: KEY, usd_per_result: 0.42 } });
  check(all.every((b) => b.earned === true && b.evidence.length > 0), `with every fact a badge is missing or has no evidence: ${JSON.stringify(all)}`);
  check(all[0].evidence.includes('drf_1') && all[3].evidence.includes('2026-W45'), 'a badge does not name its rows');

  // ---- 3. a real fwd -----------------------------------------------------------------------------------
  const home = realpathSync(freshHome('promotions'));
  let f = await startFwd(home);
  try {
    const r = await api(f.port, 'GET', '/v1/supervisor/promotions', { auth: f.token });
    if (r.status === 404 && /no route/i.test(r.text)) missing('GET /v1/supervisor/promotions does not exist (row FW-C-141)');
    check(r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length === 0, `a fresh home's promotions: ${r.status} ${r.text.slice(0, 200)}`);
    check((await api(f.port, 'GET', '/v1/supervisor/promotions')).status === 401, 'promotions without a session was not 401');
    const b = await api(f.port, 'GET', '/v1/game/badges', { auth: f.token });
    if (b.status === 404 && /no route/i.test(b.text)) missing('GET /v1/game/badges does not exist (row FW-C-141)');
    check(b.status === 200 && b.json?.data?.every((x) => x.earned === false), `a fresh home has a badge: ${b.text.slice(0, 300)}`);
  } finally {
    await f.stop();
  }
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const doc = { id: 'drf_p1', status: 'handed_off', created_at: at, sent_at: at, replied_at: at, body: 'Hi.', channel: 'email' };
  writeFileSync(join(dir, 'drf_p1.json'), `${JSON.stringify(doc, null, 2)}\n`);
  f = await startFwd(home);
  try {
    const b = (await api(f.port, 'GET', '/v1/game/badges', { auth: f.token })).json?.data ?? [];
    const fr = b.find((x) => x.id === 'first_reply');
    check(fr?.earned === true && fr.evidence.includes('drf_p1'), `one replied draft gave First Reply ${JSON.stringify(fr)}`);
    check(b.filter((x) => x.id !== 'first_reply').every((x) => x.earned === false), 'one reply earned another badge');
  } finally {
    await f.stop();
  }
});
