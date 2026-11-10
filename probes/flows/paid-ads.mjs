// Probe for FW-C-048 (paid ads flow): `pnpm probe flows/paid-ads`. Tier 0.
// Surfaces: the shipped definition in flows/paid-ads/, the daemon fwd (started as one node process
// on a fresh FW_HOME), Google Ads campaign report CSVs in $FW_HOME/flows/paid-ads/imports/, and
// GET /v1/flows/paid-ads with the CLI token fwd prints.
//
// Proves, in order:
//   1. flows/paid-ads/stream.json and config.json exist. The stream ships disabled at tier L1 with a
//      dollar cap, and holds no action class but read_research (it never touches the campaign).
//   2. A fresh fwd serves the flow with next move waiting_for_data and zero spend.
//   3. Five days of the campaign's rows (plus another campaign's, which must not count) give totals
//      that match the CSV, and next move learning.
//   4. Twenty days of spend past check_tracking_multiple x target with no subscription: check_tracking.
//   5. Twenty days with cost per subscription above target: over_target. Below target: on_target.
//   6. Any other flow key answers 404.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, requireFile, root, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/paid-ads';
const KEY = 'paid-ads';
const kids = [];

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function httpGet(port, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${token}` }, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => ok({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    req.end();
  });
}

async function startFwd(home) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function view(f) {
  const r = await httpGet(f.port, `/v1/flows/${KEY}`, f.token);
  if (r.status === 404) missing(`GET /v1/flows/${KEY} answered 404 (the flow is not served)`);
  check(r.status === 200, `GET /v1/flows/${KEY} answered ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body).data;
}

const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
const money = (n) => (n >= 1000 ? n.toLocaleString('en-US', { minimumFractionDigits: 2 }) : n.toFixed(2));

/** A Google Ads campaign report as exported: two title lines, a header, one row per day. */
function report(campaign, days, { cost, clicks = 20, impr = 400, conv = () => 0 }, other = false) {
  const lines = ['Campaign report', `"${day(days)} - ${day(1)}"`, 'Day,Campaign,Impr.,Clicks,Cost,Conversions'];
  for (let i = days; i >= 1; i--) {
    lines.push(`${day(i)},${campaign},"${impr.toLocaleString('en-US')}",${clicks},"${money(cost)}",${conv(i).toFixed(2)}`);
    if (other) lines.push(`${day(i)},Some other campaign,999,99,"1,000.00",50.00`);
  }
  return `${lines.join('\n')}\n`;
}

const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.01;

await probe(NAME, async () => {
  // ---- 1. shipped definition ---------------------------------------------------------------
  requireFile(`flows/${KEY}/stream.json`, 'the flow stream definition');
  requireFile(`flows/${KEY}/config.json`, 'the flow config: campaign, target, thresholds');
  const stream = JSON.parse(readFileSync(join(root, `flows/${KEY}/stream.json`), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(root, `flows/${KEY}/config.json`), 'utf8'));
  check(stream.enabled === false, 'stream.json must ship disabled');
  check(stream.default_tier === 'L1', `stream.json default_tier is ${stream.default_tier}, want L1`);
  check(stream.budget?.caps?.max_usd > 0, 'stream.json has no dollar cap');
  const outward = (stream.action_classes ?? []).filter((c) => c !== 'read_research');
  check(outward.length === 0, `stream.json holds action classes beyond read_research: ${outward.join(', ')}`);
  const campaign = cfg.campaign?.name;
  const target = cfg.target_cost_per_subscription_usd;
  const learningDays = cfg.learning_days;
  const multiple = cfg.check_tracking_multiple;
  check(typeof campaign === 'string' && campaign.length > 0, 'config.json names no campaign');
  check(target > 0 && learningDays > 0 && learningDays < 20 && multiple > 0, 'config.json lacks target, learning_days (<20) or check_tracking_multiple');

  const home = freshHome('ads');
  const imports = join(home, 'flows', KEY, 'imports');
  const put = (csv) => {
    rmSync(imports, { recursive: true, force: true });
    mkdirSync(imports, { recursive: true });
    writeFileSync(join(imports, 'campaign-report.csv'), csv);
  };
  try {
    // ---- 2. fresh fwd -------------------------------------------------------------------------
    const f = await startFwd(home);
    let v = await view(f);
    check(v.next_move?.kind === 'waiting_for_data', `fresh next move is ${v.next_move?.kind}, want waiting_for_data`);
    check(v.totals?.spend_usd === 0, `fresh spend is ${v.totals?.spend_usd}, want 0`);

    // ---- 3. five days, another campaign alongside ------------------------------------------------
    put(report(campaign, 5, { cost: 12.5, clicks: 20, impr: 1200, conv: (i) => (i === 2 ? 1 : 0) }, true));
    v = await view(f);
    check(near(v.totals?.spend_usd, 62.5), `spend over five days is ${v.totals?.spend_usd}, want 62.5 (another campaign counted?)`);
    check(v.totals?.clicks === 100, `clicks are ${v.totals?.clicks}, want 100`);
    check(v.totals?.impressions === 6000, `impressions are ${v.totals?.impressions}, want 6000 (comma in a number?)`);
    check(near(v.totals?.subscriptions, 1), `subscriptions are ${v.totals?.subscriptions}, want 1`);
    check(near(v.totals?.cost_per_subscription_usd, 62.5), 'cost per subscription is not spend over subscriptions');
    check(v.next_move?.kind === 'learning', `five days gives ${v.next_move?.kind}, want learning`);

    // ---- 4. spend with nothing to show -------------------------------------------------------------
    const perDay = (target * multiple) / 10; // past the line by day 10 of 20
    put(report(campaign, 20, { cost: perDay }));
    v = await view(f);
    check(v.next_move?.kind === 'check_tracking', `20 days of spend and no subscription gives ${v.next_move?.kind}, want check_tracking`);

    // ---- 5. above and below target ----------------------------------------------------------------
    put(report(campaign, 20, { cost: target / 2, conv: (i) => (i === 3 || i === 9 ? 1 : 0) })); // 10x target / 2 subs = 5x
    v = await view(f);
    check(v.next_move?.kind === 'over_target', `cost per subscription above target gives ${v.next_move?.kind}, want over_target`);
    put(report(campaign, 20, { cost: target / 4, conv: () => 1 })); // a quarter of target
    v = await view(f);
    check(v.next_move?.kind === 'on_target', `cost per subscription below target gives ${v.next_move?.kind}, want on_target`);

    // ---- 6. unknown key -----------------------------------------------------------------------
    const r = await httpGet(f.port, '/v1/flows/not-a-flow', f.token);
    check(r.status === 404, `GET /v1/flows/not-a-flow answered ${r.status}, want 404`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
