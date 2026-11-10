// Probe for FW-C-025 (projects, ledger, runs and spend screens): `pnpm probe ui/ledger-runs-spend`. Tier 0.
// probe-timeout-s: 420
// Surfaces: a fixture project with one successful fake-vendor run (a kernel-verified PR) and one
// fabricated_claim run (a PR the agent only claimed, which the kernel could not verify), `fw ledger retest`, `fw spend --by day
// --json`; a real fwd serving the built web bundle (probes/lib/web.mjs), paired, driven with
// Playwright; the database read-only.
// The surface this probe expects:
//   /ledger/<row id> shows what the row's probe measures (its probe command), the last probe status,
//   and the premise re-test time as <time datetime="<premise_retested_at>">.
//   /spend shows, for today, the same total `fw spend --by day --json` gives for today, written
//   $<usd to 2 decimals>, and the same seven-day total.
//   /runs/<run id> marks a kernel-verified artifact as verified (artifact verified, kernel-verified or
//   verified by fwd) and a run whose artifact the agent only claimed as claimed, never as verified.
//
// Proves, in order:
//   1. The row page shows the probe, its last status and the re-test time.
//   2. The spend page totals equal fw spend for the same days.
//   3. Run detail tells verified and merely claimed artifacts apart.
import {
  check,
  fixtureProject,
  fw,
  fwJson,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
} from '../c0/_lib.mjs';
import { browser, mainText, pairedPage, startUi } from '../lib/web.mjs';

const VERIFIED = /artifact verified|kernel[- ]verified|verified by fwd/i;

await probe('ui/ledger-runs-spend', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-986', extraRows: [{ id: 'FW-C-987', scenario: 'fabricated_claim' }] });
  const home = pipelineHome('screens');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed');
  const good = fwJson(['run', 'start', 'FW-C-986', '--adapter', 'fake'], o);
  check(good.status === 0, `the success run exited ${good.status}`);
  const claimed = fwJson(['run', 'start', 'FW-C-987', '--adapter', 'fake', '--scenario', 'fabricated_claim'], o);
  check(claimed.json?.run_id, 'the fabricated_claim run has no run id');
  const spend = fwJson(['spend', '--by', 'day'], o);
  check(spend.status === 0, `fw spend --by day exited ${spend.status}`);
  let db = await openDbReadonly(home);
  const row = db.prepare("SELECT id, premise_retested_at FROM ledger_rows WHERE id = 'lr_FWC987'").get();
  const verified = db.prepare('SELECT count(*) AS n FROM run_artifacts WHERE run_id = ? AND verified_by_kernel = 1').get(claimed.json.run_id).n;
  db.close();
  check(row?.premise_retested_at, 'the fixture row was never re-tested');
  check(verified === 0, 'the fabricated_claim run has a kernel-verified artifact');

  const ui = await startUi(home, { env });
  const br = await browser();
  try {
    const page = await pairedPage(ui, br);

    // 1. Row page.
    const rowText = await mainText(page, `${ui.base}/ledger/${row.id}`);
    check(rowText.includes('check-feature.mjs'), 'the row page does not show what the probe runs');
    check(/\b(pass|fail|not verified|never ran|error)\b/i.test(rowText), 'the row page does not show the last probe status');
    check((await page.locator(`time[datetime="${row.premise_retested_at}"]`).count()) >= 1, 'the row page does not show the premise re-test time');

    // 2. Spend.
    const spendText = await mainText(page, `${ui.base}/spend`);
    const today = new Date().toISOString().slice(0, 10);
    const day = (spend.json.groups ?? []).find((g) => g.day === today);
    check(day && day.usd !== null, `fw spend has no known cost for today: ${JSON.stringify(spend.json).slice(0, 200)}`);
    check(spendText.includes(`$${day.usd.toFixed(2)}`), `the spend page does not show today's $${day.usd.toFixed(2)} from fw spend`);
    const week = (spend.json.groups ?? [])
      .filter((g) => g.usd !== null && Date.parse(g.day) >= Date.parse(today) - 6 * 86400000)
      .reduce((s, g) => s + g.usd, 0);
    check(spendText.includes(`$${week.toFixed(2)}`), `the spend page does not show the seven-day $${week.toFixed(2)} from fw spend`);

    // 3. Runs.
    check(VERIFIED.test(await mainText(page, `${ui.base}/runs/${good.json.run_id}`)), 'the verified run does not mark its artifact verified');
    const claimedText = await mainText(page, `${ui.base}/runs/${claimed.json.run_id}`);
    check(/claimed/i.test(claimedText), 'the run page does not mark the claimed artifact as claimed');
    check(!VERIFIED.test(claimedText), 'the run page shows a merely claimed artifact as verified');
  } finally {
    await br.close();
    await ui.stop();
  }
});
