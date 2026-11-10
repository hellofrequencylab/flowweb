// Probe for FW-C-020 (honest UI and accessibility gate): `pnpm probe ui/honest-a11y`. Tier 0.
// probe-timeout-s: 600
// Surfaces: a real fwd serving the built packages/web bundle (probes/lib/web.mjs), paired, with a
// fixture project synced and one fake-vendor run; Playwright's Chromium; axe-core from the repo.
// The surface this probe expects:
//   A ledger row whose probe never ran says "not verified" on its row page (/ledger/<row id>), never
//   a pass.
//   axe-core reports no serious or critical violation on any Core screen (/, /table, /ledger, a row
//   page, /runs, a run page, /spend, /projects, /settings) at 390 and at 1280 px wide.
//   Every visible control on those screens (links, buttons, inputs, selects, anything focusable) is
//   reached with the Tab key alone.
//
// Proves, in order:
//   1. A row whose probe never ran renders "not verified".
//   2. Zero serious or critical axe issues on every Core screen at both widths.
//   3. Every control is reachable by keyboard.
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
import { axeSerious, axeSource, browser, pairedPage, startUi } from '../lib/web.mjs';

const TAG = 'data-probe-ctl';

/** Tabs through the page; returns the visible controls Tab never reached (as short descriptions). */
async function unreachable(page) {
  const total = await page.evaluate((tag) => {
    const sel = 'a[href], button, input, select, textarea, summary, [tabindex], [role="button"], [role="link"], [contenteditable="true"]';
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const hidden = r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none';
      if (hidden || el.disabled || el.getAttribute('tabindex') === '-1' || el.closest('[inert],[aria-hidden="true"]')) continue;
      el.setAttribute(tag, String(n++));
    }
    return n;
  }, TAG);
  const seen = new Set();
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < total * 2 + 20 && seen.size < total; i++) {
    await page.keyboard.press('Tab');
    const idx = await page.evaluate((tag) => document.activeElement?.closest(`[${tag}]`)?.getAttribute(tag) ?? null, TAG);
    if (idx !== null) seen.add(idx);
  }
  return page.evaluate(
    ([tag, got]) =>
      [...document.querySelectorAll(`[${tag}]`)]
        .filter((el) => !got.includes(el.getAttribute(tag)))
        .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`),
    [TAG, [...seen]],
  );
}

await probe('ui/honest-a11y', async () => {
  const axe = axeSource();
  const proj = fixtureProject({ rowId: 'FW-C-981', extraRows: [{ id: 'FW-C-982' }] });
  const home = pipelineHome('a11y');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  const run = fwJson(['run', 'start', 'FW-C-981', '--adapter', 'fake'], o);
  check(run.status === 0, `fw run start exited ${run.status}`);
  const db = await openDbReadonly(home);
  const never = db.prepare("SELECT id FROM ledger_rows WHERE id = 'lr_FWC982'").get()?.id;
  db.close();
  check(never, 'the fixture row FW-C-982 is not in the ledger');

  const ui = await startUi(home, { env });
  const br = await browser();
  try {
    // 1. Never ran.
    let page = await pairedPage(ui, br, { width: 1280, height: 900 });
    await page.goto(`${ui.base}/ledger/${never}`);
    await page.getByText(/not verified/i).first().waitFor({ timeout: 15000 });
    const body = await page.locator('main').innerText();
    check(!/\b(passed|pass)\b/i.test(body.replace(/not verified[^\n]*/gi, '')), 'a row whose probe never ran shows a pass');
    await page.context().close();

    // 2 and 3.
    const screens = ['/', '/table', '/ledger', `/ledger/${never}`, '/runs', `/runs/${run.json.run_id}`, '/spend', '/projects', '/settings'];
    const problems = [];
    for (const width of [390, 1280]) {
      page = await pairedPage(ui, br, { width, height: 900 });
      for (const s of screens) {
        await page.goto(ui.base + s);
        await page.waitForLoadState('networkidle');
        await page.locator('main').first().waitFor({ timeout: 15000 });
        for (const v of await axeSerious(page, axe)) problems.push(`${s} @${width}: ${v.impact} ${v.id} (${v.nodes})`);
        if (width === 1280) for (const u of await unreachable(page)) problems.push(`${s}: not reachable by Tab: ${u}`);
      }
      await page.context().close();
    }
    check(problems.length === 0, `accessibility problems:\n  ${problems.join('\n  ')}`);
  } finally {
    await br.close();
    await ui.stop();
  }
});
