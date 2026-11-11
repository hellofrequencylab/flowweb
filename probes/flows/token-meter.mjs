// Probe for FW-C-122 (meter every model turn and show tokens and dollars per outcome): `pnpm probe flows/token-meter`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=flow_drafts (a cycle reports
// 900 input, 0 cached and 300 output tokens and $0.0123, and drafts two items; a rewrite runs the fake vendor's
// draft_rewrite scenario), the Owner controls under /v1/supervisor, the new GET /v1/meter and GET
// /v1/meter/turns, the flow's outcomes.json (Frequency's counts by draft tag, as FW-C-055 writes it), and the
// database read-only.
//
// The surface this probe expects:
//   Every model turn fwd starts for a flow (a cycle, a draft rewrite, a reply or intake read) is metered once:
//     { at, flow, step: cycle | rewrite | reply | intake, item, vendor, model, tokens_in, tokens_cached,
//     tokens_out, usd, drafts } where item is the fire id (cycle) or the draft id (rewrite), and drafts lists
//     the ids of the drafts the turn wrote. flow is the flow's own key (a copy's key for a copy).
//   GET /v1/meter/turns?flow=<key>&limit=<n> (CLI token or paired session) lists them, newest first.
//   GET /v1/meter?flow=<key>&days=<1..90> answers { flow, days, turns, tokens: { input, cached, output, total },
//     usd, cache_share, packet_p95, outcomes: { drafted, sent, replied, signed_up }, per_outcome: { <outcome>:
//     { tokens, usd } | null }, by_step: { <step>: { turns, tokens, usd } }, by_model: [ { vendor, model, turns,
//     tokens, usd, drafted, sent, replied, signed_up, usd_per_outcome: { <outcome>: number | null } } ] }.
//     drafted counts the drafts metered turns wrote; sent counts those marked sent, replied or declined;
//     replied those marked replied; signed_up the members and hosts Frequency counted for their tags.
//     per_outcome divides the window's whole spend (tokens and usd) by each outcome's count, so waste counts.
//     packet_p95 is the 95th percentile of input plus cached tokens per turn; cache_share is cached over
//     input plus cached. No flow means every flow. No session 401; an unknown flow 404; bad days 400.
//   The turn's tokens and dollars match the spend_entries row fwd writes for it, cached tokens included.
//
// Proves, in order:
//   1. A cycle is metered once, with its tokens, cost, model and the drafts it wrote, matching spend_entries.
//   2. A rewrite is metered as its own step against the draft it rewrote.
//   3. Marking drafts sent and replied, and Frequency counting a sign-up for one, gives tokens and dollars per
//      outcome, overall and per model.
//   4. The routes refuse what they should, and a flow with no turns answers zeros and null per outcome.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, waitFor } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/token-meter';
const KEY = 'neighborhood-activation';
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

async function rows(home, sql, ...params) {
  const db = await openDbReadonly(home);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

await probe(NAME, async () => {
  const home = freshHome('token-meter');
  const f = await startFwd(home, { env: { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'flow_drafts' } });
  try {
    const get = (path) => api(f.port, 'GET', path, { auth: f.token });
    const post = (path, body) => api(f.port, 'POST', path, { auth: f.token, body: body ?? {} });
    const probeRoute = await get(`/v1/meter?flow=${KEY}`);
    if (probeRoute.status === 404 && /no route/i.test(probeRoute.text)) missing('GET /v1/meter does not exist (row FW-C-122)');

    // ---- 1. a cycle is metered once ---------------------------------------------------------------------
    check((await post(`/v1/supervisor/flows/${KEY}/enable`)).status === 200, `turning ${KEY} on failed`);
    const run = await post(`/v1/supervisor/flows/${KEY}/run`);
    check(run.status === 200 && run.json?.data?.outcome === 'fired', `running ${KEY} answered ${run.status}: ${run.text.slice(0, 200)}`);
    const fireId = run.json.data.fire_id;
    await waitFor(
      async () => (await rows(home, "SELECT body FROM status_reports WHERE kind = 'run'")).some((r) => JSON.parse(r.body).fire_id === fireId),
      { timeoutMs: 60000, everyMs: 250, what: 'the cycle to write its run report' },
    );
    const draftsDir = join(home, 'flows', KEY, 'drafts');
    const drafts = readdirSync(draftsDir).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(readFileSync(join(draftsDir, x), 'utf8')));
    check(drafts.length === 2, `the cycle wrote ${drafts.length} drafts, want 2`);
    const t1 = await get(`/v1/meter/turns?flow=${KEY}`);
    check(t1.status === 200, `GET /v1/meter/turns answered ${t1.status}: ${t1.text.slice(0, 200)}`);
    const turns1 = t1.json?.data ?? [];
    check(turns1.length === 1, `after one cycle the meter has ${turns1.length} turns, want 1`);
    const c = turns1[0];
    check(c.flow === KEY && c.step === 'cycle' && c.item === fireId, `the cycle's turn: ${JSON.stringify(c)}`);
    check(c.tokens_in === 900 && c.tokens_cached === 0 && c.tokens_out === 300 && near(c.usd, 0.0123), `the cycle's tokens and cost: ${JSON.stringify(c)}`);
    check(typeof c.vendor === 'string' && typeof c.model === 'string', `the cycle's turn names no vendor or model: ${JSON.stringify(c)}`);
    check(JSON.stringify([...(c.drafts ?? [])].sort()) === JSON.stringify(drafts.map((d) => d.id).sort()), `the cycle's turn lists drafts ${JSON.stringify(c.drafts)}`);
    const spend = await rows(home, "SELECT tokens_in, tokens_out, tokens_cached, usd FROM spend_entries WHERE idempotency_key = ?", `flow_cycle:${fireId}`);
    check(spend.length === 1 && spend[0].tokens_in === c.tokens_in && spend[0].tokens_out === c.tokens_out && spend[0].tokens_cached === c.tokens_cached && near(spend[0].usd, c.usd), `spend_entries for the cycle: ${JSON.stringify(spend)}`);

    // ---- 2. a rewrite is its own step --------------------------------------------------------------------
    const [a, b] = drafts.sort((x, y) => x.id.localeCompare(y.id));
    const rw = await post(`/v1/supervisor/flows/${KEY}/drafts/${a.id}/rewrite`, { instruction: 'Make it warmer' });
    check(rw.status === 200, `the rewrite answered ${rw.status}: ${rw.text.slice(0, 200)}`);
    const turns2 = (await get(`/v1/meter/turns?flow=${KEY}`)).json?.data ?? [];
    check(turns2.length === 2 && turns2[0].step === 'rewrite' && turns2[0].item === a.id, `after a rewrite the newest turn is ${JSON.stringify(turns2[0])}`);
    check(turns2[0].tokens_in + turns2[0].tokens_out > 0, `the rewrite's turn has no tokens: ${JSON.stringify(turns2[0])}`);
    check((await get(`/v1/meter/turns?flow=${KEY}&limit=1`)).json?.data?.length === 1, 'limit=1 did not cut the list to one turn');

    // ---- 3. per outcome ------------------------------------------------------------------------------------
    check((await post(`/v1/supervisor/flows/${KEY}/drafts/${a.id}/mark`, { outcome: 'sent' })).status === 200, 'marking a draft sent failed');
    check((await post(`/v1/supervisor/flows/${KEY}/drafts/${b.id}/mark`, { outcome: 'replied' })).status === 200, 'marking a draft replied failed');
    const tagB = JSON.parse(readFileSync(join(draftsDir, `${b.id}.json`), 'utf8')).tag;
    check(typeof tagB === 'string', `draft ${b.id} has no tag`);
    writeFileSync(
      join(home, 'flows', KEY, 'outcomes.json'),
      `${JSON.stringify({ outcomes: [{ campaign: KEY, content: tagB, medium: 'email', src: null, leads: 1, members: 1, hosts: 0, paid: 0 }, { campaign: KEY, content: 'not-a-metered-draft', medium: 'email', src: null, leads: 5, members: 5, hosts: 5, paid: 0 }] })}\n`,
    );
    const m = await get(`/v1/meter?flow=${KEY}&days=30`);
    check(m.status === 200, `GET /v1/meter answered ${m.status}: ${m.text.slice(0, 200)}`);
    const v = m.json?.data;
    const tokens = turns2.reduce((s, t) => s + t.tokens_in + t.tokens_cached + t.tokens_out, 0);
    const usd = turns2.reduce((s, t) => s + t.usd, 0);
    check(v?.flow === KEY && v.days === 30 && v.turns === 2, `the meter view: ${JSON.stringify(v)?.slice(0, 300)}`);
    check(v.tokens?.total === tokens && v.tokens.input === turns2.reduce((s, t) => s + t.tokens_in, 0) && near(v.usd, usd), `the meter totals ${JSON.stringify(v.tokens)} $${v.usd}, want ${tokens} $${usd}`);
    check(JSON.stringify(v.outcomes) === JSON.stringify({ drafted: 2, sent: 2, replied: 1, signed_up: 1 }), `outcomes ${JSON.stringify(v.outcomes)}, want drafted 2 sent 2 replied 1 signed_up 1`);
    check(v.per_outcome?.replied?.tokens === tokens && near(v.per_outcome.replied.usd, usd), `per reply ${JSON.stringify(v.per_outcome?.replied)}, want ${tokens} tokens $${usd}`);
    check(v.per_outcome?.drafted?.tokens === tokens / 2 && near(v.per_outcome.signed_up.usd, usd), `per draft or per sign-up is wrong: ${JSON.stringify(v.per_outcome)}`);
    check(v.by_step?.cycle?.turns === 1 && v.by_step?.rewrite?.turns === 1, `by_step ${JSON.stringify(v.by_step)}`);
    check(Array.isArray(v.by_model) && v.by_model.length >= 1, `by_model ${JSON.stringify(v.by_model)}`);
    const bm = v.by_model.find((x) => x.model === c.model);
    check(bm && bm.drafted === 2 && bm.replied === 1 && typeof bm.usd_per_outcome?.replied === 'number', `the cycle model's row ${JSON.stringify(bm)}`);
    check(v.packet_p95 >= 900, `packet_p95 ${v.packet_p95}, want at least the cycle's 900`);
    check(v.cache_share === 0, `cache_share ${v.cache_share}, want 0 with no cached tokens`);
    const all = (await get('/v1/meter')).json?.data;
    check(all?.flow === null && all.turns === 2, `GET /v1/meter with no flow: ${JSON.stringify(all)?.slice(0, 200)}`);

    // ---- 4. refusals and an empty flow -----------------------------------------------------------------------
    const none = await api(f.port, 'GET', `/v1/meter?flow=${KEY}`);
    check(none.status === 401, `the meter without a session answered ${none.status}, want 401`);
    const { cookie } = await pair(f.port, f.pairingCode);
    check((await api(f.port, 'GET', `/v1/meter?flow=${KEY}`, { auth: { cookie } })).status === 200, 'the paired session cannot read the meter');
    check((await get('/v1/meter?flow=no-such-flow')).status === 404, 'an unknown flow did not answer 404');
    for (const d of ['0', '91', 'x']) check((await get(`/v1/meter?days=${d}`)).status === 400, `days=${d} did not answer 400`);
    const empty = (await get('/v1/meter?flow=paid-ads')).json?.data;
    check(empty?.turns === 0 && empty.usd === 0 && empty.per_outcome?.replied === null, `a flow with no turns: ${JSON.stringify(empty)?.slice(0, 300)}`);
  } finally {
    await f.stop();
  }
});
