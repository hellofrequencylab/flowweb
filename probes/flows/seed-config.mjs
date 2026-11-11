// Probe for FW-C-101 (the Creator seed flow drafts in the v2 shape): `pnpm probe flows/seed-config`. Tier 0.
// Surfaces: flows/neighborhood-activation/config.json, packages/daemon/src/flows/neighborhood-activation.ts
// (loadFlow, routeLeads, seedDraft) on a fresh FW_HOME, and packages/daemon/src/flows/hunts.ts
// (fetchAllowed, newHunt, composeBody).
// The surface this probe expects:
//   config.json: first_map { territory_id, sub_areas } starting encinitas, carlsbad, solana-del-mar, inside
//   the seed region's sub_areas; niches [{ key, label, angles: [{ key, line }] }] covering sound,
//   breathwork, yoga, ecstatic-dance, music, makers-art and venue, each with 2 or 3 angles;
//   leads.max_touches_per_lead 3 (lifetime) and leads.max_new_contacts_per_day 15; hunts.send_via
//   founder_email and hunts.every_days 1; dm_door.path /start/host.
//   seedDraft(cfg, lead, { route: 'dm' | 'email', angle, tag, opener }) ->
//     { niche, angle, route, body, link, words, warnings }
//   A dm draft has no sign-off and no P.S.; an email draft keeps the Owner's sign-off, a P.S. and the
//   reply-no opt-out. Every link: /start/host, utm_source=flowweb, utm_campaign=creator-seed,
//   utm_content=<niche>.<tag>, utm_medium=one-to-one for dm, area kept, no persona; a venue carries niche=venue.
//   routeLeads caps a lead touched 3 times in its lifetime, however long ago.
//   fetchAllowed(url) is false for instagram.com and facebook.com (any subdomain); newHunt answers 400 for
//   such a link. composeBody for a social lead writes no sign-off and no P.S., and its link has no persona.
//
// Proves, in order:
//   1. The shipped config carries the first map, the niches with their angles, the touch and daily caps,
//      the founder send route, daily hunts and the one DM door.
//   2. On a fresh FW_HOME a dm draft for a sound host is short, unsigned, tagged with niche, angle and
//      route, and its link names the campaign and the niche with no persona.
//   3. An email draft for the same lead keeps the sign-off, the P.S. and the opt-out.
//   4. A venue's dm link goes through /start/host with niche venue.
//   5. A fourth touch is refused, even when the first three were months ago.
//   6. The hunt fetch guard refuses instagram.com and facebook.com, and a social hunt draft is unsigned.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/seed-config';
const KEY = 'neighborhood-activation';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;
const NICHES = ['sound', 'breathwork', 'yoga', 'ecstatic-dance', 'music', 'makers-art', 'venue'];
const DAY = 86_400_000;

await probe(NAME, async () => {
  // ---- 1. the shipped config ---------------------------------------------------------------------
  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  if (!cfg.first_map || !Array.isArray(cfg.niches)) missing('config.json has no first_map or niches (row FW-C-101)');
  const seed = cfg.territories.find((t) => t.id === cfg.seed_territory_id);
  check(cfg.first_map.territory_id === seed?.id, `first_map is in ${cfg.first_map.territory_id}, want ${seed?.id}`);
  const first = cfg.first_map.sub_areas ?? [];
  check(JSON.stringify(first.slice(0, 3)) === JSON.stringify(['encinitas', 'carlsbad', 'solana-del-mar']), `first_map starts ${first.slice(0, 3)}`);
  check(first.every((s) => seed.sub_areas.some((x) => x.id === s)), 'a first_map sub-area is not in the seed region');
  for (const k of NICHES) {
    const n = cfg.niches.find((x) => x.key === k);
    check(n && typeof n.label === 'string', `niche ${k} is missing`);
    check(Array.isArray(n.angles) && n.angles.length >= 2 && n.angles.length <= 3, `niche ${k} has ${n.angles?.length} angles, want 2 or 3`);
    check(n.angles.every((a) => typeof a.key === 'string' && typeof a.line === 'string' && !/[–—]/.test(a.line)), `niche ${k} has a bad angle`);
  }
  check(cfg.leads.max_touches_per_lead === 3, `leads.max_touches_per_lead is ${cfg.leads.max_touches_per_lead}, want 3`);
  check(cfg.leads.max_new_contacts_per_day === 15, `leads.max_new_contacts_per_day is ${cfg.leads.max_new_contacts_per_day}, want 15`);
  check(cfg.hunts.send_via === 'founder_email', `hunts.send_via is ${cfg.hunts.send_via}, want founder_email`);
  check(cfg.hunts.every_days === 1, `hunts.every_days is ${cfg.hunts.every_days}, want 1`);
  check(cfg.dm_door?.path === '/start/host', `dm_door.path is ${cfg.dm_door?.path}, want /start/host`);

  // ---- 2. a dm draft on a fresh FW_HOME ----------------------------------------------------------
  const na = await imp('packages/daemon/src/flows/neighborhood-activation.ts');
  if (typeof na.seedDraft !== 'function') missing('neighborhood-activation.ts does not export seedDraft (row FW-C-101)');
  const home = realpathSync(freshHome('seed-config'));
  try {
    const now = new Date('2026-11-11T15:00:00Z');
    const ago = (d) => new Date(now.getTime() - d * DAY).toISOString();
    const base = { territory_id: seed.id, source: 'event_listings', fit: 0.9, timing: 0.9, timing_at: ago(1), found_at: ago(2) };
    const leads = [
      { ...base, id: 'host-sound', name: 'Tide Sound', kind: 'host', niche: 'sound', sub_area: 'encinitas', channel: 'wellness', url: 'https://example.com/tide', touches: [] },
      { ...base, id: 'venue-1', name: 'Coastal Studio', kind: 'venue', sub_area: 'carlsbad', url: 'https://example.com/coastal', touches: [] },
      { ...base, id: 'old-3', name: 'Old Three', kind: 'host', niche: 'yoga', url: 'https://example.com/old', touches: [ago(120), ago(115), ago(108)] },
    ];
    mkdirSync(join(home, 'flows', KEY), { recursive: true });
    writeFileSync(join(home, 'flows', KEY, 'state.json'), JSON.stringify({ opened: [seed.id], leads }));
    const f = na.loadFlow(root, home, now);
    check(f, 'the flow did not load');
    const lead = (id) => f.state.leads.find((l) => l.id === id);
    const opener =
      "Hi Tide Sound, your full moon sound baths look beautiful and I love what you are up to!\n\nI'm Daniel, founder of Frequency, a free way for neighbors to find or start local, in-person Circles around what they love. Would it help to have one page where your crowd can find every bath?";
    const dm = na.seedDraft(f.cfg, lead('host-sound'), { route: 'dm', angle: 'scattered', tag: 'd7k2', opener });
    check(dm.niche === 'sound' && dm.angle === 'scattered' && dm.route === 'dm', `dm draft fields: ${JSON.stringify({ niche: dm.niche, angle: dm.angle, route: dm.route })}`);
    check(!/Daniel Tyack/.test(dm.body) && !/frequencylocal\.com\s*$/m.test(dm.body.split('\n').slice(-1)[0] ?? ''), `a dm draft has a sign-off: ${dm.body}`);
    check(!/P\.S\./.test(dm.body), `a dm draft has a P.S.: ${dm.body}`);
    check(!/[–—]/.test(dm.body), 'a dm draft has a dash');
    check(words(dm.body) < 120 && dm.words === words(dm.body), `a dm draft is ${words(dm.body)} words (says ${dm.words}), want under 120`);
    const link = new URL(dm.link);
    check(dm.body.includes(dm.link), 'the dm body does not carry its link');
    check(link.pathname === '/start/host', `the dm link goes to ${link.pathname}`);
    const q = (k) => link.searchParams.get(k);
    check(q('utm_source') === 'flowweb', `utm_source=${q('utm_source')}`);
    check(q('utm_medium') === 'one-to-one', `utm_medium=${q('utm_medium')}, want one-to-one`);
    check(q('utm_campaign') === 'creator-seed', `utm_campaign=${q('utm_campaign')}, want creator-seed`);
    check(q('utm_content') === 'sound.d7k2', `utm_content=${q('utm_content')}, want sound.d7k2`);
    check(!link.searchParams.has('persona'), `the dm link carries persona: ${link}`);
    check(q('area') === 'encinitas' && q('channel') === 'wellness', `the dm link lost area or channel: ${link}`);

    // ---- 3. an email draft keeps the sign-off, P.S. and opt-out -----------------------------------
    const em = na.seedDraft(f.cfg, lead('host-sound'), { route: 'email', angle: 'scattered', tag: 'd7k3', opener });
    check(em.route === 'email' && /Daniel Tyack\nFounder\nfrequencylocal\.com/.test(em.body), `an email draft lost the sign-off: ${em.body}`);
    check(/\nP\.S\. /.test(em.body) && /reply "no"/i.test(em.body), `an email draft lost the P.S. or opt-out: ${em.body}`);
    check(new URL(em.link).searchParams.get('utm_content') === 'sound.d7k3', `email utm_content: ${em.link}`);

    // ---- 4. a venue goes through the one DM door ----------------------------------------------------
    const v = na.seedDraft(f.cfg, lead('venue-1'), { route: 'dm', tag: 'v1', opener: 'Hi Coastal Studio, I love your schedule!' });
    const vl = new URL(v.link);
    check(vl.pathname === '/start/host' && vl.searchParams.get('niche') === 'venue' && v.niche === 'venue', `a venue dm link: ${v.link}`);
    check(typeof v.angle === 'string' && v.angle.length > 0, 'a venue draft has no angle');
    check(vl.searchParams.get('utm_content') === 'venue.v1', `venue utm_content: ${v.link}`);

    // ---- 5. a fourth touch is refused --------------------------------------------------------------
    const routed = na.routeLeads(f.cfg, f.state, now).find((r) => r.lead.id === 'old-3');
    check(routed?.stage === 'capped', `a lead touched 3 times months ago is ${routed?.stage}, want capped`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // ---- 6. the hunt fetch guard and the social draft --------------------------------------------------
  const hunts = await imp('packages/daemon/src/flows/hunts.ts');
  if (typeof hunts.fetchAllowed !== 'function') missing('hunts.ts does not export fetchAllowed (row FW-C-101)');
  for (const u of ['https://www.instagram.com/tide_sound', 'https://instagram.com/x', 'https://m.facebook.com/events/1', 'https://facebook.com/tide'])
    check(hunts.fetchAllowed(u) === false, `fetchAllowed(${u}) is not false`);
  check(hunts.fetchAllowed('https://www.eventbrite.com/d/ca--encinitas/sound-bath/') === true, 'an event listing page is refused');
  let status = 0;
  try {
    hunts.newHunt(cfg, { name: 'IG', looking_for: 'sound baths', region: seed.id, links: ['https://www.instagram.com/explore/tags/soundbath/'] }, new Date());
  } catch (e) {
    status = e?.status ?? -1;
  }
  check(status === 400, `a hunt with an instagram.com link answered ${status}, want 400`);
  const h = hunts.newHunt(cfg, { name: 'Sound', looking_for: 'sound baths', region: seed.id, areas: ['encinitas'] }, new Date());
  const social = {
    hunt_id: h.id,
    event: { title: 'Full moon bath', starts_at: null, url: 'https://example.com/e', country: 'US' },
    organizer: { name: 'Tide', email: '', source_url: 'https://example.com/e', country: 'US', contact_via: 'social', contact_url: 'https://www.instagram.com/tide_sound' },
    subject: null,
    body: 'Hi Tide, your full moon baths look lovely!',
    niche: 'sound',
    angle: 'fill_room',
  };
  const body = hunts.composeBody(cfg, h, social);
  check(!/Daniel Tyack/.test(body) && !/P\.S\./.test(body), `a social hunt draft is signed or has a P.S.: ${body}`);
  const hl = new URL(body.match(/https:\/\/frequencylocal\.com\/\S+/)?.[0] ?? 'https://x.invalid/');
  check(!hl.searchParams.has('persona') && hl.searchParams.get('utm_medium') === 'one-to-one', `a social hunt link: ${hl}`);
});
