// Probe for FW-C-156 (the Owner edits each flow copy): `pnpm probe flows/flow-targeting`.
// Tier 0. Committed with the Owner's approval (decision card, 2026-11-18).
// probe-timeout-s: 240
// Surfaces: a real fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hunt_leads, the CLI
// token, POST /v1/supervisor/flows/{base}/copy, GET /v1/flows/{key}, /v1/flows/{key}/hunts,
// /v1/flows/{key}/targeting, the copies' files under $FW_HOME/copies/<key>/, and the database read-only.
//
// Proves, in order:
//   1. A copy has its own view at GET /v1/flows/{copy}; a copy key nobody made answers 404.
//   2. A hunt saved under the copy is listed there, lives in the copy's hunts.json, and is deleted there;
//      the base flow's hunts never change.
//   3. Targeting reads the copy's playbook; a save changes the copy's config.json only, and a bad save
//      (em dash, unknown field, playbook without "seek") answers 400 and writes nothing.
//   4. After the save, a run of the copy writes drafts that carry the new link line.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, root, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/flow-targeting';
const BASE = 'neighborhood-activation';
const COPY = `${BASE}--coaches-guides`;
const OTHER = `${BASE}--venues-hosts`;
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const LINK_LINE = 'Come and see what we are building here:';
const SEEK = 'Breathwork, yoga and meditation guides who hold a weekly in-person circle in the region and list a public contact address.';

await probe(NAME, async () => {
  const home = realpathSync(freshHome('flow-targeting'));
  const f = await startFwd(home, { env: ENV });
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, ...(body === undefined ? {} : { body }) });
    const sup = (path, body) => call('POST', `/v1/supervisor/flows/${path}`, body ?? {});
    for (const slug of ['coaches-guides', 'venues-hosts']) {
      const made = await sup(`${BASE}/copy`, { profile: slug });
      check(made.status === 200, `making the ${slug} copy answered ${made.status}: ${made.text.slice(0, 200)}`);
    }
    const dir = (key) => join(home, 'copies', key, 'flows', BASE);
    const before = read(join(dir(COPY), 'config.json'));
    const otherBefore = readFileSync(join(dir(OTHER), 'config.json'), 'utf8');

    // ---- 1. a copy has its own view ----------------------------------------------------------------------
    const view = await call('GET', `/v1/flows/${COPY}`);
    if (view.status === 404) missing(`GET /v1/flows/${COPY} answers 404: a copy has no view (row FW-C-156)`);
    check(view.status === 200 && Array.isArray(view.json?.data?.territories), `the copy's view answered ${view.status}: ${view.text.slice(0, 200)}`);
    check(view.json.data.enabled === false, 'the copy reads as on before the Owner turned it on');
    check((await call('GET', `/v1/flows/${BASE}--nobody-made-this`)).status === 404, 'a copy key nobody made has a view');

    // ---- 2. the copy's own hunts ---------------------------------------------------------------------------
    const list = await call('GET', `/v1/flows/${COPY}/hunts`);
    if (list.status === 404) missing(`GET /v1/flows/${COPY}/hunts answers 404: hunts are base only (row FW-C-156)`);
    const starter = read(join(dir(COPY), 'hunts.json')).hunts;
    check(list.status === 200 && list.json?.data?.length === starter.length, `the copy lists ${list.json?.data?.length} hunts, its file has ${starter.length}`);
    const region = starter[0].region;
    const saved = await call('POST', `/v1/flows/${COPY}/hunts`, { name: 'Sound baths', looking_for: 'People who host sound baths', region });
    check(saved.status === 201 && /^hnt_/.test(saved.json?.data?.id ?? ''), `saving a hunt on the copy answered ${saved.status}: ${saved.text.slice(0, 200)}`);
    const id = saved.json.data.id;
    check(read(join(dir(COPY), 'hunts.json')).hunts.some((h) => h.id === id), "the saved hunt is not in the copy's hunts.json");
    check(!existsSync(join(home, 'flows', BASE, 'hunts.json')), 'saving a hunt on the copy wrote the base flow hunts');
    const baseList = await call('GET', `/v1/flows/${BASE}/hunts`);
    check(baseList.status === 200 && baseList.json.data.length === 0, `the base flow lists ${baseList.json?.data?.length} hunts, want 0`);
    check((await call('POST', `/v1/flows/${COPY}/hunts`, { name: 'x', looking_for: 'y', region: 'nowhere' })).status === 400, 'a hunt in an unknown region was saved');
    const gone = await call('DELETE', `/v1/flows/${COPY}/hunts/${id}`);
    check(gone.status === 200 && !read(join(dir(COPY), 'hunts.json')).hunts.some((h) => h.id === id), `deleting the hunt answered ${gone.status}`);
    check((await call('GET', `/v1/flows/${BASE}--nobody-made-this/hunts`)).status === 404, 'a copy key nobody made lists hunts');

    // ---- 3. targeting --------------------------------------------------------------------------------------
    const t = await call('GET', `/v1/flows/${COPY}/targeting`);
    if (t.status === 404) missing(`GET /v1/flows/${COPY}/targeting answers 404 (row FW-C-156)`);
    check(t.status === 200 && t.json?.data?.has_playbook === true, `the copy's targeting answered ${t.status}: ${t.text.slice(0, 200)}`);
    check(t.json.data.playbook.seek === before.hunts.playbook.seek && t.json.data.link_line === before.hunts.link_line, "targeting does not read the copy's playbook and link line");
    check(t.json.data.door === before.funnels.host.path && t.json.data.niches.length === before.niches.length, 'targeting does not show the page and the niches');
    const baseT = await call('GET', `/v1/flows/${BASE}/targeting`);
    check(baseT.status === 200 && baseT.json.data.has_playbook === false, 'the base flow reads as having a playbook');

    const frozen = readFileSync(join(dir(COPY), 'config.json'), 'utf8');
    const refused = [
      [{ playbook: { seek: 'Guides — the kind who host' } }, 'an em dash'],
      [{ territories: [] }, 'a field that is not targeting'],
      [{ playbook: { seek: '' } }, 'a playbook without its seek line'],
      [{ playbook: { nonsense: 'x' } }, 'an unknown playbook line'],
      [{ niches: { 'no-such-niche': { angles: ['x'] } } }, 'an unknown niche'],
    ];
    for (const [body, what] of refused) {
      const r = await call('POST', `/v1/flows/${COPY}/targeting`, body);
      check(r.status === 400, `a save with ${what} answered ${r.status}, want 400`);
    }
    check(readFileSync(join(dir(COPY), 'config.json'), 'utf8') === frozen, 'a refused save changed the config');

    const niche = before.niches[0];
    const ok = await call('POST', `/v1/flows/${COPY}/targeting`, {
      playbook: { seek: SEEK },
      link_line: LINK_LINE,
      niches: { [niche.key]: { angles: [{ key: niche.angles[0].key, line: 'Your circle already gathers neighbors every week.' }, { line: 'A second reason, added by the Owner.' }] } },
    });
    check(ok.status === 200 && ok.json?.data?.playbook?.seek === SEEK && ok.json.data.link_line === LINK_LINE, `the save answered ${ok.status}: ${ok.text.slice(0, 300)}`);
    const after = read(join(dir(COPY), 'config.json'));
    check(after.hunts.playbook.seek === SEEK && after.hunts.link_line === LINK_LINE, "the save is not in the copy's config.json");
    check(after.hunts.playbook.note === before.hunts.playbook.note && after.hunts.sign_off === before.hunts.sign_off, 'the save dropped a line it was not given');
    check(after.niches[0].key === niche.key && after.niches.length === before.niches.length && after.niches[0].angles.length === 2, 'the niche angles were not saved in place');
    check(after.niches[0].angles[0].key === niche.angles[0].key && /^[a-z0-9_]+$/.test(after.niches[0].angles[1].key) && after.niches[0].angles[1].key !== after.niches[0].angles[0].key, 'an edited angle lost its key, or a new one got none');
    check(JSON.stringify(after.territories) === JSON.stringify(before.territories) && after.funnels.host.path === before.funnels.host.path, 'the save changed the regions or the page');
    check(readFileSync(join(dir(OTHER), 'config.json'), 'utf8') === otherBefore, "a save on one copy changed another copy's config");
    check(!existsSync(join(home, 'flows', BASE, 'config.json')), 'a save on a copy wrote an override for the base flow');

    // ---- 4. the next run uses the save -----------------------------------------------------------------------
    check((await sup(`${COPY}/enable`)).status === 200, 'turning the copy on failed');
    const run = await sup(`${COPY}/run`);
    check(run.status === 200 && run.json?.data?.outcome === 'fired', `running ${COPY} answered ${run.status}: ${run.text.slice(0, 200)}`);
    await waitFor(
      async () => {
        const db = await openDbReadonly(home);
        try {
          const all = db.prepare("SELECT body FROM status_reports WHERE kind = 'run'").all();
          return all.some((r) => JSON.parse(r.body).fire_id === run.json.data.fire_id);
        } finally {
          db.close();
        }
      },
      { timeoutMs: 60000, everyMs: 250, what: "the copy's cycle to write its run report" },
    );
    const drafts = readdirSync(join(dir(COPY), 'drafts')).filter((x) => x.endsWith('.json')).map((x) => read(join(dir(COPY), 'drafts', x)));
    check(drafts.length >= 1, 'the copy wrote no drafts');
    for (const d of drafts) {
      check(d.status === 'waiting_for_owner', `draft ${d.id} is ${d.status}, want waiting_for_owner`);
      check(d.body.includes(`${LINK_LINE} `), `draft ${d.id} does not carry the new link line: ${d.body.slice(0, 300)}`);
    }
    check(!existsSync(join(home, 'outbox')) || readdirSync(join(home, 'outbox')).every((k) => readdirSync(join(home, 'outbox', k)).length === 0), 'a draft reached the outbox');
    check(existsSync(join(root, 'flows', BASE, 'profiles', 'coaches-guides.json')), 'the shipped profile is gone');
  } finally {
    await f.stop();
  }
});
