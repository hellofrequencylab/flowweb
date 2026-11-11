// Probe for FW-C-144 (a support desk flow: it sorts the inbox, drafts replies, and never sends on its own):
// `pnpm probe flows/support-desk`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: the shipped definition in flows/support-desk/, packages/daemon/src/flows/support-desk.ts (pure
// triage), a real fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=flow_drafts (no network or
// keys), the Owner controls under /v1/supervisor/flows/support-desk/..., messages the probe drops in
// $FW_HOME/flows/support-desk/inbox/ (one JSON file each), and the database read-only (status_reports).
//
// The surface this probe expects:
//   flows/support-desk/ has stream.json (ships disabled, default_tier L1, a dollar cap, and no action class
//     that sends: none of outbound_email_external, publish_external or any other *_external), config.json and
//     project.json.
//   triage({ from, subject, text }) is pure plain code and answers { category, why } with category one of
//     bug, billing, question, feature, spam. Billing words (refund, charge, invoice, card) win over bug words
//     (broken, error, crash, bug), which win over feature words (wish, could you add, feature); obvious junk
//     (unsubscribe lists, crypto, casino) is spam; anything else is a question.
//   A cycle (POST /v1/supervisor/flows/support-desk/run with the flow on) reads every message in inbox/, writes
//     one draft reply per message that is not spam into $FW_HOME/flows/support-desk/drafts/ with status
//     waiting_for_owner, category, and the message id it answers, and writes nothing to the outbox. Its run
//     report (status_reports kind run, body.flow support-desk) counts drafts. A message already answered
//     by a draft gets no second draft on the next cycle.
//   The support desk never goes past Copilot: POST .../dial { stop: 'autopilot' } answers 400.
//
// Proves, in order:
//   1. The shipped flow is off, capped and cannot send.
//   2. Triage sorts five messages the same way every time.
//   3. A run drafts replies for real messages only, sends nothing, and does not draft twice; Autopilot is refused.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, openDbReadonly, probe, root, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/support-desk';
const KEY = 'support-desk';
const S = '/v1/supervisor';
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' };
const MESSAGES = [
  { id: 'msg_1', from: 'a@example.com', subject: 'Refund please', text: 'I was charged twice for my Space this month.', want: 'billing' },
  { id: 'msg_2', from: 'b@example.com', subject: 'Page broken', text: 'The RSVP button shows an error and nothing happens.', want: 'bug' },
  { id: 'msg_3', from: 'c@example.com', subject: 'Idea', text: 'I wish I could add a waitlist to my events. Could you add that feature?', want: 'feature' },
  { id: 'msg_4', from: 'd@example.com', subject: 'Hosting', text: 'How do I invite my students to my circle?', want: 'question' },
  { id: 'msg_5', from: 'promo@example.com', subject: 'WIN BIG', text: 'Best crypto casino bonus, click now.', want: 'spam' },
];

await probe(NAME, async () => {
  // ---- 1. the shipped flow -------------------------------------------------------------------------------
  const dir = join(root, 'flows', KEY);
  if (!existsSync(join(dir, 'stream.json'))) missing('flows/support-desk/stream.json does not exist (row FW-C-144)');
  const stream = JSON.parse(readFileSync(join(dir, 'stream.json'), 'utf8'));
  check(existsSync(join(dir, 'config.json')) && existsSync(join(dir, 'project.json')), 'flows/support-desk lacks config.json or project.json');
  check(stream.key === KEY && stream.enabled === false && stream.default_tier === 'L1', `the stream: key ${stream.key}, enabled ${stream.enabled}, tier ${stream.default_tier}`);
  check(stream.budget?.caps?.max_usd > 0, 'the stream has no dollar cap');
  const sends = (stream.action_classes ?? []).filter((c) => /_external$/.test(c));
  check(sends.length === 0, `the stream can send: ${sends.join(', ')}`);

  // ---- 2. triage ----------------------------------------------------------------------------------------
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, 'packages/daemon/src/flows/support-desk.ts')).href);
  } catch {
    missing('packages/daemon/src/flows/support-desk.ts does not exist (row FW-C-144)');
  }
  if (typeof mod.triage !== 'function') missing('support-desk.ts does not export triage (row FW-C-144)');
  for (const m of MESSAGES) {
    const t = mod.triage(m);
    check(t?.category === m.want && typeof t.why === 'string' && t.why.length > 0, `${m.id} triaged as ${JSON.stringify(t)}, want ${m.want}`);
    check(JSON.stringify(mod.triage(m)) === JSON.stringify(t), `${m.id} triaged differently the second time`);
  }
  check(mod.triage({ from: 'e@example.com', subject: 'Error on my invoice', text: 'The invoice page shows the wrong card.' }).category === 'billing', 'billing words did not win over bug words');

  // ---- 3. a run drafts, sends nothing ------------------------------------------------------------------------
  const home = realpathSync(freshHome('support-desk'));
  const inbox = join(home, 'flows', KEY, 'inbox');
  mkdirSync(inbox, { recursive: true });
  for (const { want, ...m } of MESSAGES) writeFileSync(join(inbox, `${m.id}.json`), JSON.stringify({ ...m, received_at: new Date().toISOString() }));
  const f = await startFwd(home, { env: ENV });
  try {
    const post = (path, body) => api(f.port, 'POST', `${S}/flows/${KEY}/${path}`, { auth: f.token, body: body ?? {} });
    check((await post('enable')).status === 200, 'turning the support desk on was refused');
    const runOnce = async () => {
      const r = await post('run');
      check(r.status === 200 && r.json?.data?.outcome === 'fired', `running the support desk answered ${r.status}: ${r.text.slice(0, 200)}`);
      let rep;
      await waitFor(
        async () => {
          const db = await openDbReadonly(home);
          try {
            rep = db
              .prepare("SELECT body FROM status_reports WHERE kind = 'run'")
              .all()
              .map((x) => JSON.parse(x.body))
              .find((b) => b.fire_id === r.json.data.fire_id);
          } finally {
            db.close();
          }
          return !!rep;
        },
        { timeoutMs: 60000, everyMs: 250, what: 'the support desk cycle to write its run report' },
      );
      return rep;
    };
    const rep = await runOnce();
    check(rep.flow === KEY && rep.drafts === 4, `the run report: ${JSON.stringify(rep).slice(0, 300)}`);
    const ddir = join(home, 'flows', KEY, 'drafts');
    const drafts = readdirSync(ddir).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(readFileSync(join(ddir, x), 'utf8')));
    check(drafts.length === 4, `${drafts.length} drafts, want 4 (no reply to spam)`);
    check(drafts.every((d) => d.status === 'waiting_for_owner'), 'a support draft is not waiting for the Owner');
    const by = Object.fromEntries(drafts.map((d) => [d.message_id, d.category]));
    check(by.msg_1 === 'billing' && by.msg_2 === 'bug' && by.msg_3 === 'feature' && by.msg_4 === 'question' && !('msg_5' in by), `drafts by message: ${JSON.stringify(by)}`);
    const outbox = join(home, 'outbox');
    check(!existsSync(outbox) || readdirSync(outbox, { recursive: true }).length === 0, 'the support desk wrote to the outbox');
    const again = await runOnce();
    check(again.drafts === 0 && readdirSync(ddir).filter((x) => x.endsWith('.json')).length === 4, `a second run drafted again: ${JSON.stringify(again).slice(0, 200)}`);
    const dial = await post('dial', { stop: 'autopilot' });
    check(dial.status === 400, `Autopilot for the support desk answered ${dial.status}, want 400`);
  } finally {
    await f.stop();
  }
});
