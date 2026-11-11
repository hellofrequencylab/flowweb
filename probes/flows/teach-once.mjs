// Probe for FW-C-130 (teach once: an Owner's choice on a draft becomes a house rule, and matching drafts
// arrive pre-checked with the rule named): `pnpm probe flows/teach-once`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token and a paired browser session), the Copilot draft
// routes under /v1/supervisor/flows/{key}/drafts, the house rule routes under
// /v1/supervisor/flows/{key}/rules, GET /v1/supervisor, and draft files the probe writes into
// $FW_HOME/flows/neighborhood-activation/drafts/ before fwd starts (the same files a cycle writes).
//
// The surface this probe expects:
//   POST /v1/supervisor/flows/{key}/rules { decision: approve | reject, text, match, from_draft? } (CLI token
//     or paired session) saves a house rule and answers 200 { data: { id, decision, text, match, created_at } }.
//     match names one or more of channel, hunt_id, niche, area, each a string the draft field must equal.
//     text is 1 to 280 characters. No session 401; unknown flow 404; an empty match, an unknown match key,
//     an unknown decision or a bad text 400.
//   GET /v1/supervisor/flows/{key}/rules lists the flow's rules; POST .../rules/{id}/edit { text?, match? }
//     changes one; POST .../rules/{id}/delete removes it (unknown id 404). Rules survive a restart of fwd.
//   GET /v1/supervisor/flows/{key}/drafts: a draft waiting for the Owner that a rule matches carries
//     suggest: { decision, rule_id, rule } (rule is the rule's text); others carry suggest: null. A
//     suggestion never changes the draft's status and never writes to the outbox: the Owner still decides.
//   POST /v1/supervisor/flows/{key}/drafts/batch { rule_id, ids } applies the rule's decision to every id in
//     one call. If any id is not waiting or does not match the rule, nothing changes and it answers 400.
//   GET /v1/supervisor has owner_minutes: { week, as_of }: the number of distinct minutes in the last 7 days
//     in which the Owner made at least one decision on a draft, read from fwd's own records (0 on a fresh home).
//
// Proves, in order:
//   1. The rule routes exist and refuse what they should; owner_minutes starts at 0.
//   2. A rule pre-checks only the drafts it matches, names itself, and sends nothing.
//   3. A batch applies a reject rule to matching drafts only; owner minutes go up.
//   4. Rules can be edited and deleted, survive a restart, and a deleted rule suggests nothing.
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/teach-once';
const KEY = 'neighborhood-activation';
const S = '/v1/supervisor';

function seedDrafts(home) {
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const drafts = [
    { id: 'drf_t1', channel: 'email', hunt_id: 'hnt_yoga', to: 'a@example.com' },
    { id: 'drf_t2', channel: 'email', hunt_id: 'hnt_yoga', to: 'b@example.com' },
    { id: 'drf_t3', channel: 'email', hunt_id: 'hnt_sound', to: 'c@example.com' },
    { id: 'drf_t4', channel: 'instagram', hunt_id: 'hnt_yoga' },
  ];
  for (const d of drafts) {
    const doc = { status: 'waiting_for_owner', created_at: at, subject: 'Hello', body: 'Hello from the probe.', ...d };
    writeFileSync(join(dir, `${d.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

const outboxFiles = (home) => {
  const dir = join(home, 'outbox');
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((x) => String(x).endsWith('.json')) : [];
};

await probe(NAME, async () => {
  const home = realpathSync(freshHome('teach-once'));
  seedDrafts(home);
  let f = await startFwd(home);
  try {
    const R = `${S}/flows/${KEY}/rules`;
    const post = (path, body, auth = f.token) => api(f.port, 'POST', path, { auth, body: body ?? {} });
    const drafts = async () => {
      const r = await api(f.port, 'GET', `${S}/flows/${KEY}/drafts`, { auth: f.token });
      check(r.status === 200, `GET drafts answered ${r.status}: ${r.text.slice(0, 200)}`);
      return Object.fromEntries((r.json?.data ?? []).map((d) => [d.id, d]));
    };
    const minutes = async () => (await api(f.port, 'GET', S, { auth: f.token })).json?.data?.owner_minutes;

    // ---- 1. routes and refusals ---------------------------------------------------------------------------
    const none = await post(R, { decision: 'approve', text: 'Yoga emails are fine.', match: { channel: 'email' } }, null);
    if (none.status === 404 && /no route/i.test(none.text)) missing(`POST ${R} does not exist (row FW-C-130)`);
    check(none.status === 401, `a rule without a session answered ${none.status}, want 401`);
    check((await post(`${S}/flows/no-such-flow/rules`, { decision: 'approve', text: 'x', match: { channel: 'email' } })).status === 404, 'a rule on an unknown flow was not 404');
    for (const [body, why] of [
      [{ decision: 'approve', text: 'x', match: {} }, 'an empty match'],
      [{ decision: 'approve', text: 'x', match: { mood: 'happy' } }, 'an unknown match key'],
      [{ decision: 'maybe', text: 'x', match: { channel: 'email' } }, 'an unknown decision'],
      [{ decision: 'approve', text: '', match: { channel: 'email' } }, 'an empty text'],
      [{ decision: 'approve', text: 'x'.repeat(281), match: { channel: 'email' } }, 'a 281 character text'],
    ])
      check((await post(R, body)).status === 400, `${why} was not 400`);
    const m0 = await minutes();
    check(m0 && m0.week === 0 && typeof m0.as_of === 'string', `owner_minutes on a fresh home: ${JSON.stringify(m0)}`);

    // ---- 2. a rule pre-checks matching drafts and sends nothing --------------------------------------------
    const { cookie } = await pair(f.port, f.pairingCode);
    const ok = await post(R, { decision: 'approve', text: 'Yoga teacher emails like this are good to go.', match: { channel: 'email', hunt_id: 'hnt_yoga' }, from_draft: 'drf_t1' }, { cookie });
    check(ok.status === 200 && typeof ok.json?.data?.id === 'string', `saving a rule answered ${ok.status}: ${ok.text.slice(0, 200)}`);
    const ruleA = ok.json.data;
    let d = await drafts();
    for (const id of ['drf_t1', 'drf_t2'])
      check(d[id]?.suggest?.decision === 'approve' && d[id].suggest.rule_id === ruleA.id && d[id].suggest.rule === ruleA.text, `${id} is not pre-checked by the rule: ${JSON.stringify(d[id]?.suggest)}`);
    for (const id of ['drf_t3', 'drf_t4']) check(d[id] && d[id].suggest === null, `${id} does not match the rule but carries ${JSON.stringify(d[id]?.suggest)}`);
    check(Object.values(d).every((x) => x.status === 'waiting_for_owner'), 'a suggestion changed a draft status');
    check(outboxFiles(home).length === 0, 'a suggestion wrote to the outbox');

    // ---- 3. a batch applies a reject rule to matching drafts only -------------------------------------------
    const rej = await post(R, { decision: 'reject', text: 'Skip Instagram for now.', match: { channel: 'instagram' } });
    check(rej.status === 200, `saving a reject rule answered ${rej.status}`);
    const ruleB = rej.json.data;
    const B = `${S}/flows/${KEY}/drafts/batch`;
    const mixed = await post(B, { rule_id: ruleB.id, ids: ['drf_t4', 'drf_t3'] });
    check(mixed.status === 400, `a batch with a draft the rule does not match answered ${mixed.status}, want 400`);
    d = await drafts();
    check(d.drf_t4.status === 'waiting_for_owner' && d.drf_t3.status === 'waiting_for_owner', 'a refused batch changed a draft');
    const good = await post(B, { rule_id: ruleB.id, ids: ['drf_t4'] }, { cookie });
    check(good.status === 200, `a matching batch answered ${good.status}: ${good.text.slice(0, 200)}`);
    d = await drafts();
    check(d.drf_t4.status === 'rejected', `after the batch drf_t4 is ${d.drf_t4.status}`);
    check(['drf_t1', 'drf_t2', 'drf_t3'].every((id) => d[id].status === 'waiting_for_owner'), 'the batch touched a draft it did not name');
    const m1 = await minutes();
    check(m1?.week >= 1, `after a decision owner_minutes.week is ${m1?.week}, want at least 1`);

    // ---- 4. edit, restart, delete -------------------------------------------------------------------------
    const ed = await post(`${R}/${ruleA.id}/edit`, { text: 'Yoga emails: good to go.' });
    check(ed.status === 200, `editing a rule answered ${ed.status}`);
    await f.stop();
    f = await startFwd(home);
    const list = await api(f.port, 'GET', R, { auth: f.token });
    check(list.status === 200 && list.json?.data?.length === 2, `after a restart the rules are ${list.text.slice(0, 300)}`);
    d = await drafts();
    check(d.drf_t2?.suggest?.rule === 'Yoga emails: good to go.', `the edited rule is not named on drf_t2: ${JSON.stringify(d.drf_t2?.suggest)}`);
    check((await post(`${R}/${ruleA.id}/delete`)).status === 200, 'deleting a rule was refused');
    check((await post(`${R}/rul_nope/delete`)).status === 404, 'deleting an unknown rule was not 404');
    d = await drafts();
    check(d.drf_t1.suggest === null && d.drf_t2.suggest === null, 'a deleted rule still pre-checks drafts');
  } finally {
    await f.stop();
  }
});
