// Probe for FW-C-102 (no draft that breaks a hard rule waits in the Owner's inbox): `pnpm probe flows/draft-gate`.
// Tier 0.
// Surfaces: packages/daemon/src/flows/draft-gate.ts (checkDraft, persistDraft), packages/daemon/src/flows/facts.ts
// (readFacts, refreshFacts), listDrafts and approveDraft in packages/daemon/src/overseer/drafts.ts, and
// runFlowCycle in packages/daemon/src/overseer/cycle.ts. The TypeScript is loaded with the repo's tsx loader in a child.
//
// The surface this probe expects:
//   checkDraft(draft, ctx) -> { ok, blocks: [{code, detail}], warns: [{code, detail}] }. Block codes include dash,
//   unsourced_number, midnight, no_tagged_link, too_long and touch_limit; a draft that breaks one rule gets that code.
//   persistDraft({ dir, doc: {id, ...}, draft, ctx }) stores the draft as <dir>/<id>.json: status gate_blocked and
//   gate.blocks when it breaks a rule, else waiting_for_owner.
//   approveDraft refuses a gate_blocked draft; listDrafts never shows one as waiting_for_owner.
//   A flow cycle at Autopilot stores a draft that says "Midnight" as gate_blocked and puts nothing of it in the outbox.
//   refreshFacts({ fwHome, site }) does a signed GET of /api/webhooks/flowweb-facts when crd_frequencyoutcomes is set
//   and writes $FW_HOME/facts.json; a failed refresh keeps the last good facts.json and records why in facts-pull.json.
//
// Proves, in order:
//   1. A dash, an invented price, Midnight, a missing link, 130 words and a 4th touch each end gate_blocked with
//      the right reason, and a clean draft waits for the Owner.
//   2. A blocked draft cannot be approved and is not counted as waiting.
//   3. A real cycle at Autopilot never hands off a blocked draft.
//   4. A failed facts refresh keeps the old file.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/draft-gate';
const KEY = 'neighborhood-activation';
const url = (rel) => JSON.stringify(pathToFileURL(join(root, rel)).href);
const GATE_TS = join(root, 'packages/daemon/src/flows/draft-gate.ts');
const FACTS_TS = join(root, 'packages/daemon/src/flows/facts.ts');

function runTs(code, env = {}) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  return new Promise((ok) => {
    // Async so this process's own fake Frequency can answer while the child runs.
    {
      const c = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
        cwd: root,
        env: { ...process.env, FW_VENDOR: 'fake', ...env },
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => c.kill('SIGKILL'), 90000);
      c.stdout.on('data', (b) => (out += b));
      c.stderr.on('data', (b) => (err += b));
      c.on('close', (status) => {
        clearTimeout(timer);
        check(status === 0, `loading the TypeScript failed: ${(err || out).slice(0, 800)}`);
        ok(JSON.parse(out.trim().split('\n').pop()));
      });
    }
  });
}

await probe(NAME, async () => {
  if (!existsSync(GATE_TS)) missing('packages/daemon/src/flows/draft-gate.ts does not exist (row FW-C-102)');
  if (!existsSync(FACTS_TS)) missing('packages/daemon/src/flows/facts.ts does not exist (row FW-C-102)');
  const home = realpathSync(freshHome('draft-gate'));
  try {
    // 1 and 2. The gate, through the store, the inbox list and approval.
    const r = await runTs(`
      const g = await import(${url('packages/daemon/src/flows/draft-gate.ts')});
      const dr = await import(${url('packages/daemon/src/overseer/drafts.ts')});
      const { join } = await import('node:path');
      const dir = join(${JSON.stringify(home)}, 'flows', ${JSON.stringify(KEY)}, 'drafts');
      const LINK = 'https://frequencylocal.com/start/host?utm_source=flowweb&utm_content=sound.t1';
      const clean = "Hi Sam, your sound bath on the 20th looks lovely. I'm Daniel, founder of Frequency, a free way for neighbors to find local Circles. Want a page for it? " + LINK;
      const ctx = { facts: { beta_ends: '2026-12-31', prices: { founding_year: 99 }, launcher_minutes: 12 }, source: 'Full moon sound bath, Nov 20' };
      const cases = {
        dash: { body: clean + ' It was great \\u2014 truly.' },
        price: { body: clean + ' It is only $49 a year.' },
        midnight: { body: clean + ' We could talk at Midnight.' },
        nolink: { body: clean.replace(LINK, 'https://frequencylocal.com/start/host') },
        long: { body: clean + ' ' + 'really '.repeat(130) },
        touch4: { body: clean, touch: 4 },
        clean: { body: clean, to: 'sam@example.com' },
      };
      const out = {};
      for (const [id, draft] of Object.entries(cases)) {
        const doc = await g.persistDraft({ dir, doc: { id, flow: ${JSON.stringify(KEY)}, lead_id: 'lead-' + id, channel: 'founder_email' }, draft, ctx });
        out[id] = { status: doc.status, codes: (doc.gate?.blocks ?? []).map((b) => b.code) };
      }
      const listed = dr.listDrafts(${JSON.stringify(root)}, ${JSON.stringify(home)}, ${JSON.stringify(KEY)});
      out.waiting = listed.filter((d) => d.status === 'waiting_for_owner').map((d) => d.id).sort();
      try {
        dr.approveDraft({ writer: null, repoRoot: ${JSON.stringify(root)}, fwHome: ${JSON.stringify(home)}, flow: ${JSON.stringify(KEY)}, id: 'midnight' });
        out.approve = 'approved';
      } catch (e) { out.approve = String(e?.message ?? e); }
      console.log(JSON.stringify(out));
    `);
    const want = {
      dash: 'dash',
      price: 'unsourced_number',
      midnight: 'midnight',
      nolink: 'no_tagged_link',
      long: 'too_long',
      touch4: 'touch_limit',
    };
    for (const [id, code] of Object.entries(want)) {
      check(r[id]?.status === 'gate_blocked', `the ${id} draft is ${r[id]?.status}, want gate_blocked`);
      check(
        JSON.stringify(r[id].codes) === JSON.stringify([code]),
        `the ${id} draft was blocked for ${JSON.stringify(r[id].codes)}, want ["${code}"]`,
      );
    }
    check(r.clean?.status === 'waiting_for_owner' && r.clean.codes.length === 0, `the clean draft is ${JSON.stringify(r.clean)}`);
    check(JSON.stringify(r.waiting) === '["clean"]', `the inbox shows ${JSON.stringify(r.waiting)} as waiting, want only the clean draft`);
    check(/gate_blocked/.test(r.approve), `approving a gate_blocked draft answered: ${r.approve}`);

    // 3. A real cycle at Autopilot never hands a blocked draft to the outbox.
    const c = await runTs(`
      const { openStore } = await import(${url('packages/eventlog/src/index.ts')});
      const { ensureFwHome } = await import(${url('packages/daemon/src/daemon.ts')});
      const cy = await import(${url('packages/daemon/src/overseer/cycle.ts')});
      const sv = await import(${url('packages/daemon/src/overseer/index.ts')});
      const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const home = join(${JSON.stringify(home)}, 'cycle');
      mkdirSync(home, { recursive: true });
      ensureFwHome(home);
      const store = openStore({ path: join(home, 'db', 'fw.sqlite'), lockPath: join(home, 'fwd.lock') });
      const w = store.writer;
      const KEY = ${JSON.stringify(KEY)};
      sv.setFlowEnabled(w, ${JSON.stringify(root)}, KEY, true);
      let hash;
      try { sv.setDial(w, ${JSON.stringify(root)}, home, KEY, 'autopilot'); } catch (e) { hash = e?.details?.confirm_hash; }
      sv.setDial(w, ${JSON.stringify(root)}, home, KEY, 'autopilot', hash);
      const cdir = join(home, 'flows', KEY, 'cycles', 'fireg');
      const drafts = [
        { id: 'bad', lead_id: 'lead-1', send_via: 'founder_email', body: 'Hi Sam, want to talk at Midnight?' },
        { id: 'ok', lead_id: 'lead-2', send_via: 'founder_email', body: 'Hi Ana, would you host a small Circle?' },
      ];
      const factory = () => ({ start: () => {
        writeFileSync(join(cdir, 'drafts.json'), JSON.stringify({ drafts }));
        return { events: (async function* () {})(), result: Promise.resolve({ status: 'completed', turns: 1, cost: { usd: 0.01 } }) };
      } });
      await cy.runFlowCycle({ writer: w, repoRoot: ${JSON.stringify(root)}, fwHome: home, env: {}, keychain: false, adapterFactory: factory },
        { flow: KEY, streamId: String(cy.flowStream(${JSON.stringify(root)}, KEY)?.id), fireId: 'fireg' });
      const read = (id) => JSON.parse(readFileSync(join(home, 'flows', KEY, 'drafts', 'fireg-' + id + '.json'), 'utf8'));
      const ob = join(home, 'outbox', KEY);
      console.log(JSON.stringify({ bad: read('bad'), ok: read('ok'), outbox: existsSync(ob) ? readdirSync(ob).sort() : [] }));
      store.close();
    `);
    check(c.bad.status === 'gate_blocked', `a cycle draft that says Midnight is ${c.bad.status}, want gate_blocked`);
    check((c.bad.gate?.blocks ?? []).some((b) => b.code === 'midnight'), `its reasons are ${JSON.stringify(c.bad.gate)}`);
    check(!c.outbox.includes('fireg-bad.json'), `the blocked draft reached the outbox: ${JSON.stringify(c.outbox)}`);
    check(c.ok.status === 'handed_off' && c.outbox.includes('fireg-ok.json'), `a clean draft at Autopilot is ${c.ok.status}, outbox ${JSON.stringify(c.outbox)}`);

    // 4. Facts: a good refresh writes the sheet, a failed one keeps it and says why.
    let answer = { status: 200, body: JSON.stringify({ beta_ends: '2026-12-31', prices: { founding_year: 99 }, launcher_minutes: 12 }) };
    const seen = [];
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['x-flowweb-signature'] ? 'signed' : 'unsigned'}`);
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const site = `http://127.0.0.1:${srv.address().port}`;
      const fhome = join(home, 'facts');
      const refresh = `
        const f = await import(${url('packages/daemon/src/flows/facts.ts')});
        const fs = await import('node:fs');
        const { join } = await import('node:path');
        const home = ${JSON.stringify(fhome)};
        fs.mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(join(home, 'creds', 'crd_frequencyoutcomes'), 'probe-secret', { mode: 0o600 });
        const r = await f.refreshFacts({ fwHome: home, site: ${JSON.stringify(site)} });
        const pull = fs.existsSync(join(home, 'facts-pull.json')) ? JSON.parse(fs.readFileSync(join(home, 'facts-pull.json'), 'utf8')) : null;
        console.log(JSON.stringify({ r, facts: f.readFacts(home), pull }));
      `;
      const good = await runTs(refresh);
      check(good.r.ok === true && good.facts?.beta_ends === '2026-12-31', `a good refresh gave ${JSON.stringify(good)}`);
      check(seen[0] === 'GET /api/webhooks/flowweb-facts signed', `Frequency saw ${JSON.stringify(seen)}`);
      answer = { status: 503, body: '{}' };
      const bad = await runTs(refresh);
      check(bad.r.ok === false, `a refresh against a 503 answered ${JSON.stringify(bad.r)}`);
      check(bad.facts?.beta_ends === '2026-12-31' && bad.facts?.prices?.founding_year === 99, `a failed refresh lost the facts: ${JSON.stringify(bad.facts)}`);
      check(bad.pull?.ok === false && /503/.test(String(bad.pull?.error)), `the failure was not recorded: ${JSON.stringify(bad.pull)}`);
    } finally {
      srv.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
