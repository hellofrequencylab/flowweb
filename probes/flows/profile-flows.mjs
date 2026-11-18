// Probe for FW-C-152 (three profile flows beside the Saturation Engine): `pnpm probe flows/profile-flows`.
// Tier 0. Committed with the Owner's approval (decision card, 2026-11-18).
// probe-timeout-s: 240
// Surfaces: a real fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hunt_leads, the CLI
// token, POST /v1/supervisor/flows/{base}/copy, the Owner controls under /v1/supervisor/flows/{key}/..., the
// base flow's do-not-contact route, the copies' files under $FW_HOME/copies/<key>/, the profile files in
// flows/neighborhood-activation/profiles/, and the database read-only.
//
// Proves, in order:
//   1. The three profiles make three copies with their own names, pages, playbooks and starter hunts; an
//      unknown profile is refused with 400 and the same profile twice with 409.
//   2. With blocked@example.org on the BASE flow's do-not-contact list, a run of the coaches copy drafts a,
//      d and f into its own folder, blocks b, and every draft links to /for/coaches-and-healers and waits
//      for the Owner. The base flow has no drafts and nothing reaches the outbox.
//   3. The base flow, given the same hunt, drafts for nobody: all three were written to by the copy.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, root, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/profile-flows';
const BASE = 'neighborhood-activation';
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' };
const S = '/v1/supervisor';
const PROFILES = {
  'coaches-guides': '/for/coaches-and-healers',
  'venues-hosts': '/for/venues',
  'local-businesses': '/for/local-businesses',
};
const PLAYBOOK = ['seek', 'signals', 'where', 'queries', 'skip', 'rank', 'record', 'note'];
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const DASH = /[–—]/;

await probe(NAME, async () => {
  const home = realpathSync(freshHome('profile-flows'));
  const baseCfg = read(join(root, 'flows', BASE, 'config.json'));
  for (const slug of Object.keys(PROFILES))
    if (!existsSync(join(root, 'flows', BASE, 'profiles', `${slug}.json`)))
      missing(`flows/${BASE}/profiles/${slug}.json does not exist (row FW-C-152)`);

  const f = await startFwd(home, { env: ENV });
  try {
    const post = (path, body) => api(f.port, 'POST', `${S}/flows/${path}`, { auth: f.token, body: body ?? {} });
    const flowOf = async (key) =>
      ((await api(f.port, 'GET', S, { auth: f.token })).json?.data?.flows ?? []).find((x) => x.key === key);
    const report = async (fireId, what) => {
      let rep;
      await waitFor(
        async () => {
          const db = await openDbReadonly(home);
          try {
            const all = db.prepare("SELECT body FROM status_reports WHERE kind = 'run'").all();
            rep = all.map((r) => JSON.parse(r.body)).find((b) => b.fire_id === fireId);
          } finally {
            db.close();
          }
          return !!rep;
        },
        { timeoutMs: 60000, everyMs: 250, what },
      );
      return rep;
    };

    // ---- 1. three profiles, three copies ---------------------------------------------------------------
    const bad = await post(`${BASE}/copy`, { profile: 'no-such-profile' });
    if (bad.status === 200) missing(`POST ${S}/flows/${BASE}/copy ignores "profile" (row FW-C-152)`);
    check(bad.status === 400, `an unknown profile answered ${bad.status}, want 400`);
    check(!existsSync(join(home, 'copies')), 'an unknown profile still made a copy');
    for (const [slug, door] of Object.entries(PROFILES)) {
      const key = `${BASE}--${slug}`;
      const prof = read(join(root, 'flows', BASE, 'profiles', `${slug}.json`));
      const made = await post(`${BASE}/copy`, { profile: slug });
      check(made.status === 200, `making ${key} answered ${made.status}: ${made.text.slice(0, 300)}`);
      const fv = made.json?.data?.flow;
      check(made.json?.data?.key === key && fv?.copy_of === BASE, `the copy's key is ${made.json?.data?.key}, want ${key}`);
      check(fv.enabled === false && fv.dial === 'draft', `${key} starts ${fv.enabled ? 'on' : 'off'} at ${fv.dial}, want off at draft`);
      check(fv.name === prof.name && fv.name !== (await flowOf(BASE))?.name, `${key} is named ${JSON.stringify(fv.name)}`);
      const dir = join(home, 'copies', key, 'flows', BASE);
      const cfg = read(join(dir, 'config.json'));
      for (const k of PLAYBOOK)
        check(typeof cfg.hunts?.playbook?.[k] === 'string' && cfg.hunts.playbook[k].length > 40, `${key}: hunts.playbook.${k} is missing`);
      check(typeof cfg.hunts.link_line === 'string' && cfg.hunts.link_line.endsWith(':'), `${key}: hunts.link_line is ${JSON.stringify(cfg.hunts.link_line)}`);
      check(cfg.funnels?.host?.path === door && cfg.dm_door?.path === door, `${key} links to ${cfg.funnels?.host?.path} and ${cfg.dm_door?.path}, want ${door}`);
      check(Array.isArray(cfg.niches) && cfg.niches.length >= 2 && JSON.stringify(cfg.niches) !== JSON.stringify(baseCfg.niches), `${key} has no niches of its own`);
      check(cfg.hunts.sign_off === baseCfg.hunts.sign_off && cfg.offer?.url === baseCfg.offer.url, `${key} lost the base sign-off or offer address`);
      check(JSON.stringify(cfg.territories) === JSON.stringify(baseCfg.territories), `${key} changed the territories`);
      check(!DASH.test(JSON.stringify(cfg.hunts.playbook) + JSON.stringify(cfg.niches)), `${key}: its playbook or niches carry an em or en dash`);
      const hunts = existsSync(join(dir, 'hunts.json')) ? read(join(dir, 'hunts.json')).hunts : [];
      check(hunts.length >= 1 && hunts.every((h) => /^hnt_/.test(h.id) && h.enabled === true && h.region), `${key} starts with hunts ${JSON.stringify(hunts).slice(0, 200)}`);
    }
    check(!existsSync(join(home, 'flows', BASE, 'config.json')), 'making a profile copy wrote an override for the base flow');
    const again = await post(`${BASE}/copy`, { profile: 'coaches-guides' });
    check(again.status === 409, `making the same profile copy twice answered ${again.status}, want 409`);

    // ---- 2. a run of the coaches copy, with the base flow's do-not-contact list --------------------------
    const COPY = `${BASE}--coaches-guides`;
    const copyDir = join(home, 'copies', COPY, 'flows', BASE);
    const dnc = await api(f.port, 'POST', `/v1/flows/${BASE}/do-not-contact`, { auth: f.token, body: { email: 'blocked@example.org', reason: 'asked not to be contacted' } });
    check(dnc.status === 200, `adding to the base flow's do-not-contact answered ${dnc.status}: ${dnc.text.slice(0, 200)}`);
    check((await post(`${COPY}/enable`)).status === 200, 'turning the coaches copy on failed');
    const run = await post(`${COPY}/run`);
    check(run.status === 200 && run.json?.data?.outcome === 'fired', `running ${COPY} answered ${run.status}: ${run.text.slice(0, 200)}`);
    const rep = await report(run.json.data.fire_id, "the coaches copy's cycle to write its run report");
    const hc = rep.hunts?.[0];
    check(rep.flow === COPY && hc, `the run report: ${JSON.stringify(rep).slice(0, 300)}`);
    check(hc.drafted === 3 && hc.blocked === 1 && hc.not_public === 1 && hc.duplicate === 1, `the coaches hunt counted ${JSON.stringify(hc)}; want 3 drafted, 1 blocked by the base flow's do-not-contact, 1 not public, 1 duplicate`);
    const drafts = readdirSync(join(copyDir, 'drafts')).filter((x) => x.endsWith('.json')).map((x) => read(join(copyDir, 'drafts', x)));
    check(drafts.length === 3, `the coaches copy has ${drafts.length} drafts, want 3`);
    const line = read(join(copyDir, 'config.json')).hunts.link_line;
    for (const d of drafts) {
      check(d.status === 'waiting_for_owner', `draft ${d.id} is ${d.status}, want waiting_for_owner`);
      check(d.to !== 'blocked@example.org', 'a draft was written to an address on do-not-contact');
      check(d.body.includes(`${line} `) && /\/for\/coaches-and-healers\?[^\s]*src=hunt/.test(d.body), `draft ${d.id} does not link to /for/coaches-and-healers after the profile's link line: ${d.body.slice(0, 400)}`);
      check(/reply "no"/.test(d.body) && d.body.includes(baseCfg.hunts.sign_off), `draft ${d.id} lost the sign-off or the opt-out line`);
      check(!DASH.test(d.body + d.subject), `draft ${d.id} carries an em or en dash`);
    }
    check(!existsSync(join(home, 'flows', BASE, 'drafts')) || readdirSync(join(home, 'flows', BASE, 'drafts')).length === 0, 'the copy drafted into the base flow folder');
    check(!existsSync(join(home, 'outbox')) || readdirSync(join(home, 'outbox')).every((k) => readdirSync(join(home, 'outbox', k)).length === 0), 'a draft reached the outbox');

    // ---- 3. the base flow never writes to someone a copy wrote to ----------------------------------------
    mkdirSync(join(home, 'flows', BASE), { recursive: true });
    writeFileSync(join(home, 'flows', BASE, 'hunts.json'), JSON.stringify({ version: 1, hunts: read(join(copyDir, 'hunts.json')).hunts.map((h) => ({ ...h, last_run_at: null })) }));
    check((await post(`${BASE}/enable`)).status === 200, 'turning the base flow on failed');
    const run2 = await post(`${BASE}/run`);
    check(run2.status === 200 && run2.json?.data?.outcome === 'fired', `running ${BASE} answered ${run2.status}: ${run2.text.slice(0, 200)}`);
    const rep2 = await report(run2.json.data.fire_id, "the base flow's cycle to write its run report");
    const hb = rep2.hunts?.[0];
    check(rep2.flow === BASE && hb, `the base run report: ${JSON.stringify(rep2).slice(0, 300)}`);
    check(hb.drafted === 0 && hb.duplicate >= 3 && hb.blocked === 1, `the base hunt counted ${JSON.stringify(hb)}; want 0 drafted and the copy's three contacts as duplicates`);
    const baseDrafts = existsSync(join(home, 'flows', BASE, 'drafts')) ? readdirSync(join(home, 'flows', BASE, 'drafts')).filter((x) => x.endsWith('.json')) : [];
    check(baseDrafts.length === 0, `the base flow drafted ${baseDrafts.length} notes to people the copy already wrote to`);
  } finally {
    await f.stop();
  }
});
