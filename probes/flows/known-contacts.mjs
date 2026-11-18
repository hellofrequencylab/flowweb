// Probe for FW-C-155 (a hunt is told who was already contacted): `pnpm probe flows/known-contacts`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token, FW_VENDOR=fake, FW_FAKE_SCENARIO=hunt_leads);
// POST /v1/flows/{key}/hunts and POST /v1/flows/{key}/hunts/{id}/run; the cycle folder
// $FW_HOME/flows/<key>/cycles/<fire>/; the drafts folder $FW_HOME/flows/<key>/drafts/;
// $FW_HOME/flows/<key>/leads.json; GET /v1/flows/{key}/today.
// Why: on 2026-11-14 three of a hunt's ten finds were organizers the flow had already written to, so
// fwd dropped them and the morning came up short. And on 2026-11-18 the Owner's Today held 14 "approve
// lead" asks and no drafts: each was a lead whose draft had aged off, so the tap led nowhere.
// The surface this probe expects:
//   A hunt cycle that runs when the flow has already drafted for someone has known.json in its cycle
//   folder: { known: [{ name, contact, page }] }, one entry per address or contact page the flow (or a
//   copy of it) still holds as a hunt contact, with the name and public page from the draft written for
//   them. A first cycle, with nobody contacted yet, has no known.json.
//   Today never offers an approve_lead ask for a lead a hunt has drafted for, whatever became of that
//   draft. A lead with no draft is still asked about.
//
// Proves, in order:
//   1. The first hunt cycle has no known.json.
//   2. The second cycle's known.json names everyone the first cycle drafted for.
//   3. Today does not ask about the lead of a skipped hunt draft, and still asks about a lead with none.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/known-contacts';
const ROW = 'FW-C-155';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/hunts`;
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

await probe(NAME, async () => {
  const home = realpathSync(freshHome('known-contacts'));
  const f = await startFwd(home, { env: ENV });
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, body });
    const flow = join(home, 'flows', KEY);
    const drafts = () =>
      (existsSync(join(flow, 'drafts')) ? readdirSync(join(flow, 'drafts')) : [])
        .filter((x) => x.endsWith('.json'))
        .map((x) => ({ file: join(flow, 'drafts', x), ...read(join(flow, 'drafts', x)) }));

    const reports = async () => {
      const db = await openDbReadonly(home);
      try {
        return db
          .prepare("SELECT body FROM status_reports WHERE kind = 'run' ORDER BY created_at")
          .all()
          .map((r) => JSON.parse(r.body));
      } finally {
        db.close();
      }
    };
    async function runHunt(id) {
      const run = await call('POST', `${BASE}/${id}/run`);
      check(run.status === 200, `running the hunt answered ${run.status}: ${run.text.slice(0, 200)}`);
      const rd = run.json?.data;
      check(rd?.outcome === 'fired', `running the hunt: outcome ${rd?.outcome} (${rd?.reason ?? ''}), want fired`);
      await waitFor(async () => (await reports()).some((b) => b.fire_id === rd.fire_id), {
        timeoutMs: 30000,
        everyMs: 250,
        what: 'the hunt cycle to write its run report',
      });
      return join(flow, 'cycles', rd.fire_id.replace(/[^A-Za-z0-9_-]/g, '_'));
    }

    const en = await call('POST', `/v1/supervisor/flows/${KEY}/enable`);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}: ${en.text.slice(0, 200)}`);
    const made = await call('POST', BASE, {
      name: 'Sound baths in Encinitas',
      looking_for: 'sound baths and breathwork workshops',
      region: 'north-county-sd',
      max_sends: 2,
    });
    check(made.status === 201, `saving a hunt answered ${made.status}: ${made.text.slice(0, 200)}`);
    const hunt = made.json?.data;

    // ---- 1. nobody contacted yet -------------------------------------------------------------------
    const c1 = await runHunt(hunt.id);
    check(existsSync(join(c1, 'hunts.json')), 'the first cycle folder has no hunts.json');
    check(!existsSync(join(c1, 'known.json')), 'the first cycle has a known.json though nobody was contacted yet');
    const first = drafts().filter((d) => d.hunt_id === hunt.id);
    check(first.length === 2, `the first run drafted ${first.length}, want 2`);

    // ---- 2. the next hunt is told who they are -------------------------------------------------------
    const c2 = await runHunt(hunt.id);
    if (!existsSync(join(c2, 'known.json')))
      missing(`the second hunt cycle has no known.json naming who was already contacted (row ${ROW})`);
    const known = read(join(c2, 'known.json')).known;
    check(Array.isArray(known), `known.json: ${JSON.stringify(known).slice(0, 200)}`);
    for (const d of first) {
      const k = known.find((x) => x.contact === String(d.to).toLowerCase());
      check(k, `known.json does not list ${d.to}: ${JSON.stringify(known).slice(0, 300)}`);
      check(k.name === d.name, `known.json names ${d.to} as ${JSON.stringify(k.name)}, want ${JSON.stringify(d.name)}`);
      check(k.page === d.source_url, `known.json gives ${d.to} the page ${JSON.stringify(k.page)}, want ${d.source_url}`);
    }
    check(known.length === 2, `known.json lists ${known.length} contacts after a first run of 2`);

    // ---- 3. Today asks only about people with no draft ------------------------------------------------
    const skipped = first[0];
    const { file, ...doc } = skipped;
    writeFileSync(file, JSON.stringify({ ...doc, status: 'rejected' }));
    const lp = join(flow, 'leads.json');
    const graph = existsSync(lp) ? read(lp) : { nodes: [] };
    const nodes = (graph.nodes ?? []).filter((n) => n.source_url !== skipped.source_url);
    const node = (id, name, source_url) => ({ id, kind: 'person', name, source_url, state: 'proposed', score: { value: 0.5 } });
    writeFileSync(
      lp,
      JSON.stringify({
        ...graph,
        nodes: [...nodes, node('probe-skipped', skipped.name, skipped.source_url), node('probe-met', 'Met at the market', 'https://example.com/met')],
      }),
    );
    const t = await call('GET', `/v1/flows/${KEY}/today`);
    check(t.status === 200, `GET today answered ${t.status}: ${t.text.slice(0, 200)}`);
    const asked = (t.json?.data?.actions ?? []).filter((a) => a.kind === 'approve_lead').map((a) => a.lead_id);
    check(asked.includes('probe-met'), `Today does not ask about a lead with no draft: ${JSON.stringify(asked)}`);
    check(!asked.includes('probe-skipped'), `Today asks to approve a lead whose hunt draft was skipped: ${JSON.stringify(asked)}`);
  } finally {
    await f.stop();
  }
});
