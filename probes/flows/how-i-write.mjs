// Probe for FW-C-167 (a saved "How I write" note shapes every draft and rewrite, and the Owner's edits to
// drafts are kept for it to learn from): `pnpm probe flows/how-i-write`.
// probe-timeout-s: 420
// Tier 0. Committed with the Owner's approval (decision card, 2026-11-18).
// Surfaces: a real fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hunt_leads and the CLI
// token; $FW_HOME/voice.json and $FW_HOME/voice-edits.jsonl; runFlowCycle (packages/daemon/src/overseer/
// cycle.ts) and rewriteDraft (overseer/rewrite.ts) run on that same home, once fwd has stopped, with a stub
// engine that records the work order it is handed (the adapterFactory seam the unit tests use), so no model
// is called; hosted/relay/fw-relay.mjs --dump; requestOf and fwdCallFor in hosted/server/requests.mjs; and the
// Settings panel packages/web/src/settings/VoiceSettings.tsx, whose checks are in how-i-write.spec.tsx.
//
// The surface this probe expects (CLI token or the paired browser; 401 without):
//   GET  /v1/voice            -> { note, saved, updated_at, edits }. With nothing saved, note is the shipped
//                                original (it holds the note the Owner approved) and saved is false.
//   POST /v1/voice { note }   -> the same view. 400 for an em or en dash, the word "Midnight", more than 2000
//                                characters or no text; '' clears the saved note.
//   GET  /v1/voice/edits?limit=20 -> the newest [{ at, flow, draft_id, before, after }] first.
//   A hunt brief and a rewrite prompt carry: How the Owner writes, in his words: "<the note as JSON>"
//   The site: POST /voice queues kind flow.edit, flow 'all', payload { voice: { note } }; the relay turns that
//   into POST /voice on fwd and mirrors GET /voice.
//
// Proves, in order:
//   1. A fresh fwd answers the shipped original, unsaved. A note with an em dash (or the banned word, or too
//      long) is refused with 400 and nothing is written. A good note is saved and read back; '' clears it.
//   2. Saving an edit that changes a waiting draft's body keeps exactly one before and after pair; an edit of
//      the subject alone, or to the same words, keeps none.
//   3. The relay's snapshot carries /voice.
//   4. The next hunt brief of the base flow and of a copy both carry the saved note after the shipped voice
//      (the base flow's three fixed sentences and the copy's own playbook note are still there), and so does
//      the prompt of an AI rewrite.
//   5. The site's save travels as a flow.edit and the relay maps it to POST /voice.
//   6. The Settings panel checks pass (4 of them): it saves through the queued request.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, openDbReadonly, probe, root, tmpDir, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/how-i-write';
const BASE = 'neighborhood-activation';
const COPY = `${BASE}--coaches-guides`;
const OTHER = `${BASE}--venues-hosts`;
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' };
const NOTE = 'I write short and warm, like a neighbor would. I say "thanks so much" once, never twice. No big words.';
const BLOCK = `How the Owner writes, in his words: ${JSON.stringify(NOTE)}`;
const INTRO = "I'm Daniel, a local community builder and the founder of Frequency!";
const url = (p) => JSON.stringify(pathToFileURL(join(root, p)).href);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

function runTs(code) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  check(r.status === 0, `loading the TypeScript failed: ${(r.stderr || r.stdout || '').slice(0, 900)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

await probe(NAME, async () => {
  const home = realpathSync(freshHome('how-i-write'));
  const voiceFile = join(home, 'voice.json');
  let draftId = '';
  const f = await startFwd(home, { env: ENV });
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, ...(body === undefined ? {} : { body }) });
    const sup = (path, body) => call('POST', `/v1/supervisor/flows/${path}`, body ?? {});

    // ---- 1. the note ---------------------------------------------------------------------------------------
    const first = await call('GET', '/v1/voice');
    if (first.status === 404) missing('GET /v1/voice answers 404: fwd keeps no "How I write" note (row FW-C-167)');
    check(first.status === 200, `GET /v1/voice answered ${first.status}: ${first.text.slice(0, 200)}`);
    check(first.json.data.saved === false && first.json.data.edits === 0, `a fresh fwd says ${JSON.stringify(first.json.data).slice(0, 200)}`);
    check(first.json.data.note.includes(INTRO) && !/[–—]/.test(first.json.data.note), 'the original does not hold the note the Owner approved');
    check(first.json.data.note.length <= 2000, 'the original is longer than a note may be');
    check((await api(f.port, 'GET', '/v1/voice')).status === 401, 'the note is readable without a token');
    check((await api(f.port, 'POST', '/v1/voice', { body: { note: NOTE } })).status === 401, 'the note can be saved without a token');
    const refused = [
      ['Warm — never stiff.', 'an em dash'],
      ['Pages 3–4 of my notes.', 'an en dash'],
      ['Like burning the Midnight oil.', 'the word "Midnight"'],
      ['x'.repeat(2001), 'more than 2000 characters'],
      [42, 'no text'],
    ];
    for (const [note, what] of refused) {
      const r = await call('POST', '/v1/voice', { note });
      check(r.status === 400, `a note with ${what} answered ${r.status}, want 400`);
      check(typeof r.json?.error?.message === 'string' && r.json.error.message.length > 10, `the refusal of ${what} gives no reason`);
    }
    check(!existsSync(voiceFile), 'a refused note was written to voice.json');
    const saved = await call('POST', '/v1/voice', { note: NOTE });
    check(saved.status === 200 && saved.json?.data?.note === NOTE && saved.json.data.saved === true, `saving the note answered ${saved.status}: ${saved.text.slice(0, 200)}`);
    check(read(voiceFile).note === NOTE && !Number.isNaN(Date.parse(read(voiceFile).updated_at)), 'voice.json does not hold the note and when it was saved');
    const cleared = await call('POST', '/v1/voice', { note: '' });
    check(cleared.status === 200 && cleared.json.data.saved === false && cleared.json.data.note === first.json.data.note, 'an empty note did not put the original back');
    check((await call('POST', '/v1/voice', { note: NOTE })).status === 200, 'saving the note a second time failed');
    const got = await call('GET', '/v1/voice');
    check(got.json?.data?.note === NOTE && got.json.data.saved === true, `GET /v1/voice after the save says ${got.text.slice(0, 200)}`);

    // ---- 2. an edit to a waiting draft is kept --------------------------------------------------------------
    for (const slug of ['coaches-guides', 'venues-hosts']) {
      const made = await sup(`${BASE}/copy`, { profile: slug });
      check(made.status === 200, `making the ${slug} copy answered ${made.status}: ${made.text.slice(0, 200)}`);
    }
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
      { timeoutMs: 90000, everyMs: 250, what: "the copy's cycle to write its run report" },
    );
    const drafts = (await call('GET', `/v1/supervisor/flows/${COPY}/drafts`)).json?.data ?? [];
    const d = drafts.find((x) => x.status === 'waiting_for_owner');
    check(d, `the copy has no waiting draft (${drafts.length} drafts)`);
    draftId = d.id;
    const edit = (body) => call('POST', `/v1/supervisor/flows/${COPY}/drafts/${d.id}/edit`, body);
    const pairs = async () => (await call('GET', '/v1/voice/edits?limit=20')).json?.data;
    check((await edit({ subject: 'A subject of my own' })).status === 200, 'editing the subject failed');
    check((await edit({ body: d.body })).status === 200, 'saving the same words failed');
    check(Array.isArray(await pairs()) && (await pairs()).length === 0, `an edit that changed no words was kept: ${JSON.stringify(await pairs()).slice(0, 200)}`);
    const mine = `${d.body}\n\nThanks so much for reading this far.`;
    check((await edit({ body: mine })).status === 200, 'editing the body failed');
    const kept = await pairs();
    check(kept.length === 1, `one changed draft kept ${kept.length} pairs, want 1`);
    check(kept[0].before === d.body && kept[0].after === mine && kept[0].flow === COPY && kept[0].draft_id === d.id, `the pair is not the draft before and after: ${JSON.stringify(kept[0]).slice(0, 300)}`);
    check(!Number.isNaN(Date.parse(kept[0].at)) && Object.keys(kept[0]).sort().join() === 'after,at,before,draft_id,flow', `the pair holds more than the two bodies: ${Object.keys(kept[0]).join()}`);
    check(readFileSync(join(home, 'voice-edits.jsonl'), 'utf8').trim().split('\n').length === 1, 'voice-edits.jsonl does not hold one line');
    check((await call('GET', '/v1/voice')).json.data.edits === 1, 'GET /v1/voice does not count the kept edit');
    check((await api(f.port, 'GET', '/v1/voice/edits')).status === 401, 'the kept edits are readable without a token');

    // A hunt for the base flow, which has not run: step 4 reads the brief it gets.
    const hunt = await call('POST', `/v1/flows/${BASE}/hunts`, { name: 'Kirtan', looking_for: 'kirtan circles', region: 'north-county-sd' });
    check(hunt.status === 201, `saving a hunt on the base flow answered ${hunt.status}: ${hunt.text.slice(0, 200)}`);

    // ---- 3. the relay mirrors the note ----------------------------------------------------------------------
    const dump = join(tmpDir('how-i-write-relay'), 'dump.json');
    const relay = spawnSync(process.execPath, [join(root, 'hosted/relay/fw-relay.mjs'), '--dump', dump], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, FW_HOME: home, FW_PORT: String(f.port), FW_CLI_TOKEN: f.token },
    });
    check(relay.status === 0 && existsSync(dump), `the relay's snapshot failed: ${(relay.stderr || relay.stdout || '').slice(0, 400)}`);
    const text = readFileSync(dump, 'utf8');
    check(text.includes('/voice') && text.includes(JSON.stringify(NOTE).slice(1, -1).slice(0, 40)), "the relay's snapshot does not carry /voice with the saved note");
  } finally {
    await f.stop();
  }

  // ---- 4. the brief and the rewrite prompt, with no model ---------------------------------------------------
  const r = runTs(`
    const { openStore } = await import(${url('packages/eventlog/src/index.ts')});
    const c = await import(${url('packages/daemon/src/overseer/cycle.ts')});
    const o = await import(${url('packages/daemon/src/overseer/index.ts')});
    const rw = await import(${url('packages/daemon/src/overseer/rewrite.ts')});
    const home = ${JSON.stringify(home)};
    const repoRoot = ${JSON.stringify(root)};
    const store = openStore({ path: home + '/db/fw.sqlite', lockPath: home + '/fwd.lock' });
    const w = store.writer;
    const goals = [];
    const adapterFactory = () => ({
      start: (input) => {
        goals.push(input.work_order.goal);
        return { events: (async function* () {})(), result: Promise.resolve({ status: 'completed', turns: 0, cost: { usd: 0 } }) };
      },
    });
    const d = { writer: w, repoRoot, fwHome: home, env: {}, keychain: false, adapterFactory };
    const out = {};
    for (const [name, key] of [['base', ${JSON.stringify(BASE)}], ['copy', ${JSON.stringify(OTHER)}]]) {
      o.setFlowEnabled(w, repoRoot, key, true);
      const streamId = String(w.get('SELECT id FROM streams WHERE key = ?', [key])?.id ?? '');
      await c.runFlowCycle(d, { flow: key, streamId, fireId: 'probe_' + name });
      out[name] = goals.pop() ?? null;
    }
    try {
      await rw.rewriteDraft(d, { flow: ${JSON.stringify(COPY)}, id: ${JSON.stringify(draftId)}, instruction: 'Make it warmer' });
    } catch (e) {
      out.rewriteEnded = String(e?.message ?? e);
    }
    out.rewrite = goals.pop() ?? null;
    store.close();
    console.log(JSON.stringify(out));
  `);
  const flat = (s) => String(s).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ');
  check(typeof r.base === 'string' && r.base.includes('Lead hunts:'), `the base flow's cycle handed the engine no hunt brief: ${String(r.base).slice(0, 200)}`);
  check(flat(r.base).includes(INTRO), 'the base brief lost the shipped voice');
  check(r.base.includes(BLOCK), "the base flow's hunt brief does not carry the saved note");
  check(r.base.indexOf(BLOCK) > r.base.indexOf('Pages in Bloom'), 'the saved note is not after the shipped voice in the base brief');
  const copyNote = read(join(home, 'copies', OTHER, 'flows', BASE, 'config.json')).hunts.playbook.note;
  check(typeof r.copy === 'string' && r.copy.includes(copyNote), `the copy's cycle handed the engine no brief with its own note: ${String(r.copy).slice(0, 200)}`);
  check(r.copy.includes(BLOCK) && r.copy.indexOf(BLOCK) > r.copy.indexOf(copyNote), "the copy's hunt brief does not carry the saved note after its own");
  check(typeof r.rewrite === 'string' && r.rewrite.includes('Make it warmer'), `the rewrite never reached the engine: ${r.rewriteEnded}`);
  check(r.rewrite.includes(BLOCK), 'the rewrite prompt does not carry the saved note');
  for (const g of [r.base, r.copy, r.rewrite]) check(/Never send, post or email anything/.test(g), 'a prompt lost its never-send line');

  // ---- 5. the site's save ----------------------------------------------------------------------------------
  const { requestOf, fwdCallFor } = await import(pathToFileURL(join(root, 'hosted/server/requests.mjs')).href);
  const req = requestOf('POST', '/voice', { note: NOTE });
  check(req && !req.error, `the site may not ask to save the note: ${JSON.stringify(req)}`);
  check(req.kind === 'flow.edit' && req.flow === 'all' && req.payload?.voice?.note === NOTE, `the save is queued as ${JSON.stringify(req).slice(0, 200)}`);
  const kinds = readFileSync(join(root, 'hosted/supabase/migrations/0014_flowweb_email_queue_stage.sql'), 'utf8');
  check(kinds.includes(`'${req.kind}'`), `the hosted database does not allow the kind ${req.kind}`);
  const to = fwdCallFor(req);
  check(to?.method === 'POST' && to.path === '/voice' && to.body?.note === NOTE, `the relay maps the save to ${JSON.stringify(to)}`);
  check(requestOf('POST', '/voice', { note: 'Warm — never stiff.' })?.error, 'the site queues a note with an em dash');
  check(fwdCallFor(requestOf('POST', `/supervisor/flows/${COPY}/edit`, { name: 'Coaches' }))?.path === `/supervisor/flows/${COPY}/edit`, 'a rename is no longer a rename');

  // ---- 6. the Settings panel -------------------------------------------------------------------------------
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('how-i-write'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/how-i-write.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const ui = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${ui.stdout ?? ''}${ui.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(ui.status === 0, `the Settings panel checks failed (exit ${ui.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 Settings panel checks to pass:\n${out.slice(-400)}`);
});
