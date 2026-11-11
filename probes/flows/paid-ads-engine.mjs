// Probe for FW-C-138 (the paid ads flow gets decision logic: it stops showing "no engine" and proposes
// budget moves as cards the Owner answers): `pnpm probe flows/paid-ads-engine`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token), GET /v1/supervisor, the Owner controls
// POST /v1/supervisor/flows/paid-ads/{enable,run}, GET /v1/decision-cards, Google Ads report CSVs the probe
// drops in $FW_HOME/flows/paid-ads/imports/ (the format probes/flows/paid-ads.mjs uses), and the database
// read-only (status_reports).
//
// The surface this probe expects:
//   ENGINES has paid-ads, so its FlowView gate is never no_engine. Its caps are the stream's budget.
//   POST /v1/supervisor/flows/paid-ads/run runs one cycle in plain code (no model call, no spend) that reads
//     the imports and the flow's next move (nextMove in packages/daemon/src/flows/paid-ads.ts). Its run
//     report (status_reports kind run, body.flow paid-ads, body.fire_id) has outcome proposed when it
//     opened a card and quiet otherwise.
//   over_target or on_target opens one choose decision card: title names Paid ads, ask names the cost per
//     subscription and the target as dollar amounts, 2 to 4 options (one keeps things as they are), a
//     recommended_option and a recommendation_reason. While a paid ads card is open, a cycle with the same
//     figures opens no second one. waiting_for_data, learning and check_tracking open no budget card.
//   The flow never changes the campaign: it holds no ad account credential and its stream keeps
//     read_research as its only action class.
//
// Proves, in order:
//   1. Paid ads has an engine on a fresh home.
//   2. With no report, a run is quiet and opens no card.
//   3. Twenty days over target open one choose card with dollar figures and a recommendation; a second run
//      does not open another.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, root, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/paid-ads-engine';
const KEY = 'paid-ads';
const S = '/v1/supervisor';
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function report(campaign, days, cost, conv) {
  const lines = ['Campaign report', `"${day(days)} - ${day(1)}"`, 'Day,Campaign,Impr.,Clicks,Cost,Conversions'];
  for (let i = days; i >= 1; i--) lines.push(`${day(i)},${campaign},400,20,"${cost.toFixed(2)}",${conv(i).toFixed(2)}`);
  return `${lines.join('\n')}\n`;
}

async function runReport(home, fireId) {
  let rep;
  await waitFor(
    async () => {
      const db = await openDbReadonly(home);
      try {
        const all = db
          .prepare("SELECT body FROM status_reports WHERE kind = 'run'")
          .all()
          .map((r) => JSON.parse(r.body));
        rep = all.find((b) => b.fire_id === fireId);
      } finally {
        db.close();
      }
      return !!rep;
    },
    { timeoutMs: 60000, everyMs: 250, what: 'the paid ads cycle to write its run report' },
  );
  return rep;
}

await probe(NAME, async () => {
  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  const stream = JSON.parse(readFileSync(join(root, 'flows', KEY, 'stream.json'), 'utf8'));
  check(
    JSON.stringify(stream.action_classes) === JSON.stringify(['read_research']),
    `paid-ads action classes are ${JSON.stringify(stream.action_classes)}`,
  );
  const target = cfg.target_cost_per_subscription_usd;
  const home = realpathSync(freshHome('paid-ads-engine'));
  const f = await startFwd(home);
  try {
    const view = async () =>
      ((await api(f.port, 'GET', S, { auth: f.token })).json?.data?.flows ?? []).find((x) => x.key === KEY);
    const cards = async () => {
      const r = await api(f.port, 'GET', '/v1/decision-cards?status=open', { auth: f.token });
      check(r.status === 200, `GET /v1/decision-cards answered ${r.status}`);
      return (r.json?.data ?? []).filter((c) => /paid ads/i.test(c.title ?? ''));
    };
    const run = async () => {
      const r = await api(f.port, 'POST', `${S}/flows/${KEY}/run`, { auth: f.token, body: {} });
      check(
        r.status === 200 && r.json?.data?.outcome === 'fired',
        `running paid-ads answered ${r.status}: ${r.text.slice(0, 200)}`,
      );
      return runReport(home, r.json.data.fire_id);
    };

    // ---- 1. an engine ------------------------------------------------------------------------------------
    let v = await view();
    check(v, 'GET /v1/supervisor does not list paid-ads');
    const en = await api(f.port, 'POST', `${S}/flows/${KEY}/enable`, { auth: f.token, body: {} });
    check(en.status === 200, 'turning paid-ads on was refused');
    v = await view();
    if (v.gate === 'no_engine') missing('paid-ads still has no engine: the Supervisor holds it by no_engine (row FW-C-138)');
    check(
      v.gate !== 'no_engine' && v.budget?.max_usd === stream.budget.caps.max_usd,
      `paid-ads when on: gate ${v.gate}, budget ${JSON.stringify(v.budget)}`,
    );

    // ---- 2. no report, no card ---------------------------------------------------------------------------
    let rep = await run();
    check(rep.flow === KEY && rep.outcome === 'quiet', `a run with no report: ${JSON.stringify(rep).slice(0, 300)}`);
    check((await cards()).length === 0, 'a run with no report opened a card');

    // ---- 3. over target opens one card -------------------------------------------------------------------
    const dir = join(home, 'flows', KEY, 'imports');
    mkdirSync(dir, { recursive: true });
    // $30 a day and one subscription every fifth day: $150 a subscription, far above the target.
    writeFileSync(join(dir, 'campaign-report.csv'), report(cfg.campaign.name, 20, 30, (i) => (i % 5 === 0 ? 1 : 0)));
    rep = await run();
    check(rep.outcome === 'proposed', `a run over target: ${JSON.stringify(rep).slice(0, 300)}`);
    let open = await cards();
    check(open.length === 1, `over target opened ${open.length} paid ads cards, want 1`);
    const c = open[0];
    const body = c.body ?? {};
    check(c.variant === 'choose', `the card is a ${c.variant} card, want choose`);
    check(
      c.ask.includes('$150.00') && c.ask.includes(`$${target.toFixed(2)}`),
      `the ask does not name $150.00 and the $${target.toFixed(2)} target: ${c.ask}`,
    );
    const opts = body.options ?? c.options ?? [];
    check(opts.length >= 2 && opts.length <= 4, `the card has ${opts.length} options`);
    const rec = body.recommended_option ?? c.recommended_option;
    check(
      opts.some((o) => o.id === rec),
      `the recommended option ${rec} is not one of the options`,
    );
    check(
      typeof (body.recommendation_reason ?? c.recommendation_reason) === 'string',
      'the card has no recommendation reason',
    );
    check(
      opts.some((o) => /keep|as is|no change/i.test(`${o.id} ${o.label}`)),
      'no option keeps the campaign as it is',
    );
    rep = await run();
    open = await cards();
    check(open.length === 1, `a second run with the same figures left ${open.length} paid ads cards open, want 1`);
  } finally {
    await f.stop();
  }
});
