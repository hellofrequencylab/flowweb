// Probe for FW-C-121 (run more than one copy of a flow, each with its own config, state and drafts): `pnpm probe flows/flow-copies`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=flow_drafts (so a cycle
// runs without a network or keys), the CLI token and a paired browser session, GET /v1/supervisor and the
// Owner controls under /v1/supervisor/flows/{key}/..., the copy's files under $FW_HOME/copies/<key>/, and
// the database read-only.
//
// The surface this probe expects:
//   POST /v1/supervisor/flows/{base}/copy { slug?, name?, note?, config? } (CLI token or paired session)
//     makes a copy of a shipped flow and answers 200 with { data: { key, flow } }: key is "<base>--<slug>"
//     (slug defaults to the next free number from 2), flow is its FlowView, off and at draft. config is a
//     shallow patch over the base flow's config; a top-level key the base config does not have is 400. The
//     copy's effective config is written to $FW_HOME/copies/<key>/flows/<base>/config.json, and the base
//     flow's config is untouched. No session 401; unknown base 404; a slug that is not lowercase letters,
//     digits and single dashes, or a key over 41 characters, 400; a copy that exists already 409; a copy of
//     a copy 400.
//   GET /v1/supervisor lists every copy beside the shipped flows; each FlowView has copy_of (the base key,
//     or null on a shipped flow).
//   Every per-flow Owner control (enable, disable, dial, edit, archive, restore, run, drafts) takes a copy's
//     key. Turning a copy on registers its own stream (key = the copy's key, a different stream id); running
//     it runs one cycle whose run report names the copy's key, whose drafts land in
//     $FW_HOME/copies/<key>/flows/<base>/drafts/, and whose spend counts against the copy alone.
//   Copies live in the Supervisor settings, so they survive a restart of fwd.
//
// Proves, in order:
//   1. fwd makes a copy with its own name and config, and refuses what it should.
//   2. The copy is listed with copy_of; the base flow and its config are unchanged.
//   3. A run of the copy registers its own stream, drafts into its own folder and spends on its own budget;
//      the base flow stays off with no drafts and no spend.
//   4. The Owner controls work on the copy alone (dial, edit, archive), and the copy survives a restart.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, root, waitFor } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/flow-copies';
const BASE = 'neighborhood-activation';
const SLUG = 'austin';
const COPY = `${BASE}--${SLUG}`;
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' };
const S = '/v1/supervisor';

async function rows(home, sql, ...params) {
  const db = await openDbReadonly(home);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

await probe(NAME, async () => {
  const home = realpathSync(freshHome('flow-copies'));
  const baseCfg = JSON.parse(readFileSync(join(root, 'flows', BASE, 'config.json'), 'utf8'));
  const baseStream = JSON.parse(readFileSync(join(root, 'flows', BASE, 'stream.json'), 'utf8'));
  const patchKey = Object.keys(baseCfg).find((k) => typeof baseCfg[k] === 'string' && k !== 'version');
  check(patchKey, `the ${BASE} config has no string key to patch`);

  let f = await startFwd(home, { env: ENV });
  try {
    const sup = async () => (await api(f.port, 'GET', S, { auth: f.token })).json?.data;
    const flowOf = async (key) => ((await sup())?.flows ?? []).find((x) => x.key === key);
    const post = (path, body) => api(f.port, 'POST', `${S}/flows/${path}`, { auth: f.token, body: body ?? {} });

    // ---- 1. make a copy ----------------------------------------------------------------------------------
    const none = await api(f.port, 'POST', `${S}/flows/${BASE}/copy`, { body: { slug: SLUG } });
    if (none.status === 404 && /no route/i.test(none.text)) missing(`POST ${S}/flows/${BASE}/copy does not exist (row FW-C-121)`);
    check(none.status === 401, `a copy without a session or token answered ${none.status}, want 401`);
    const { cookie } = await pair(f.port, f.pairingCode);
    const made = await api(f.port, 'POST', `${S}/flows/${BASE}/copy`, {
      auth: { cookie },
      body: { slug: SLUG, name: 'Yoga teachers in Austin', note: 'Second city.', config: { [patchKey]: 'probe-copy-value' } },
    });
    check(made.status === 200, `making a copy answered ${made.status}: ${made.text.slice(0, 300)}`);
    check(made.json?.data?.key === COPY, `the copy's key is ${made.json?.data?.key}, want ${COPY}`);
    const fv = made.json?.data?.flow;
    check(fv?.key === COPY && fv.copy_of === BASE && fv.enabled === false && fv.dial === 'draft', `the copy's view: ${JSON.stringify(fv)?.slice(0, 300)}`);
    check(fv.name === 'Yoga teachers in Austin' && fv.note === 'Second city.', `the copy's name and note: ${fv.name} / ${fv.note}`);

    const again = await post(`${BASE}/copy`, { slug: SLUG });
    check(again.status === 409, `making the same copy twice answered ${again.status}, want 409`);
    const auto = await post(`${BASE}/copy`, {});
    check(auto.status === 200 && auto.json?.data?.key === `${BASE}--2`, `a copy without a slug answered ${auto.status} key ${auto.json?.data?.key}, want ${BASE}--2`);
    for (const [body, why] of [
      [{ slug: 'Bad Slug' }, 'a slug with capitals and a space'],
      [{ slug: 'a--b' }, 'a slug with a double dash'],
      [{ slug: 'x'.repeat(40) }, 'a key over 41 characters'],
      [{ slug: 'ok', config: { not_a_key_of_the_base: 1 } }, 'a config key the base does not have'],
      [{ slug: 'ok', config: 'nope' }, 'a config that is not an object'],
    ]) {
      const r = await post(`${BASE}/copy`, body);
      check(r.status === 400, `${why} answered ${r.status}, want 400`);
    }
    const ofCopy = await post(`${COPY}/copy`, { slug: 'again' });
    check(ofCopy.status === 400, `a copy of a copy answered ${ofCopy.status}, want 400`);
    const unknown = await post('no-such-flow/copy', { slug: 'x' });
    check(unknown.status === 404, `a copy of an unknown flow answered ${unknown.status}, want 404`);

    // ---- 2. listed, and the base untouched -------------------------------------------------------------
    const base = await flowOf(BASE);
    check(base && base.copy_of === null, `the base flow's copy_of is ${JSON.stringify(base?.copy_of)}, want null`);
    check((await flowOf(COPY))?.copy_of === BASE, `GET ${S} does not list ${COPY} with copy_of ${BASE}`);
    const cfgFile = join(home, 'copies', COPY, 'flows', BASE, 'config.json');
    check(existsSync(cfgFile), `the copy's config is not at ${cfgFile}`);
    const copyCfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    check(copyCfg[patchKey] === 'probe-copy-value', `the copy's config ${patchKey} is ${JSON.stringify(copyCfg[patchKey])}`);
    const kept = Object.keys(baseCfg).filter((k) => k !== patchKey);
    check(kept.every((k) => JSON.stringify(copyCfg[k]) === JSON.stringify(baseCfg[k])), 'the copy lost or changed a key of the base config it did not patch');
    check(JSON.parse(readFileSync(join(root, 'flows', BASE, 'config.json'), 'utf8'))[patchKey] === baseCfg[patchKey], 'making a copy changed the repo config');
    check(!existsSync(join(home, 'flows', BASE, 'config.json')), 'making a copy wrote an override for the base flow');

    // ---- 3. a run of the copy is the copy's alone ------------------------------------------------------
    const en = await post(`${COPY}/enable`);
    check(en.status === 200, `turning the copy on answered ${en.status}: ${en.text.slice(0, 200)}`);
    const st = await rows(home, 'SELECT id, key FROM streams');
    const mine = st.filter((s) => s.key === COPY);
    check(mine.length === 1 && mine[0].id !== baseStream.id, `streams after turning the copy on: ${JSON.stringify(st)}`);
    check(!st.some((s) => s.key === BASE), 'turning the copy on registered the base flow too');
    const run = await post(`${COPY}/run`);
    check(run.status === 200 && run.json?.data?.outcome === 'fired', `running the copy answered ${run.status}: ${run.text.slice(0, 200)}`);
    let rep;
    await waitFor(
      async () => {
        const all = (await rows(home, "SELECT body FROM status_reports WHERE kind = 'run'")).map((r) => JSON.parse(r.body));
        rep = all.find((b) => b.fire_id === run.json.data.fire_id);
        return !!rep;
      },
      { timeoutMs: 60000, everyMs: 250, what: "the copy's cycle to write its run report" },
    );
    check(rep.flow === COPY && rep.stream_id === mine[0].id, `the run report names ${rep.flow} on ${rep.stream_id}`);
    check(rep.outcome === 'drafted' && rep.drafts >= 1, `the copy's cycle: ${JSON.stringify(rep).slice(0, 300)}`);
    const dir = join(home, 'copies', COPY, 'flows', BASE, 'drafts');
    const files = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : [];
    check(files.length === rep.drafts, `the copy's drafts folder has ${files.length} drafts, the report says ${rep.drafts}`);
    check(!existsSync(join(home, 'flows', BASE, 'drafts')), 'the copy drafted into the base flow folder');
    const listed = await api(f.port, 'GET', `${S}/flows/${COPY}/drafts`, { auth: { cookie } });
    check(listed.status === 200 && listed.json?.data?.length === files.length, `GET drafts for the copy: ${listed.status} ${listed.text.slice(0, 200)}`);
    const baseDrafts = await api(f.port, 'GET', `${S}/flows/${BASE}/drafts`, { auth: f.token });
    check(baseDrafts.status === 200 && baseDrafts.json?.data?.length === 0, `the base flow lists ${baseDrafts.json?.data?.length} drafts, want 0`);
    const cv = await flowOf(COPY);
    const bv = await flowOf(BASE);
    check((cv?.budget?.spent_usd ?? 0) > 0 || (cv?.budget?.used_turns ?? 0) > 0, `the copy shows no spend: ${JSON.stringify(cv?.budget)}`);
    check((bv?.budget?.spent_usd ?? 0) === 0 && (bv?.budget?.used_turns ?? 0) === 0, `the base flow shows the copy's spend: ${JSON.stringify(bv?.budget)}`);
    check(bv?.enabled === false, 'the base flow was turned on');

    // ---- 4. the copy's own controls, and a restart --------------------------------------------------------
    const dial = await post(`${COPY}/dial`, { stop: 'copilot' });
    check(dial.status === 200 && (await flowOf(COPY))?.dial === 'copilot', `the copy's dial answered ${dial.status}`);
    check((await flowOf(BASE))?.dial === 'draft', 'setting the copy dial moved the base flow');
    const ed = await post(`${COPY}/edit`, { name: 'Yoga, Austin' });
    check(ed.status === 200 && (await flowOf(COPY))?.name === 'Yoga, Austin', `renaming the copy answered ${ed.status}`);
    const ar = await post(`${BASE}--2/archive`);
    check(ar.status === 200 && (await flowOf(`${BASE}--2`))?.archived === true, `archiving the second copy answered ${ar.status}`);
    check((await flowOf(COPY))?.archived === false && (await flowOf(BASE))?.archived === false, 'archiving one copy archived another flow');
    await f.stop();
    f = await startFwd(home, { env: ENV });
    const after = await flowOf(COPY);
    check(after?.copy_of === BASE && after.enabled === true && after.name === 'Yoga, Austin', `after a restart the copy is ${JSON.stringify(after)?.slice(0, 300)}`);
  } finally {
    await f.stop();
  }
});
