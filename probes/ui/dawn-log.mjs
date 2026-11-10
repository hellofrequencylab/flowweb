// Probe for FW-C-024 (Dawn Log screen): `pnpm probe ui/dawn-log`. Tier 0.
// probe-timeout-s: 420
// Surfaces: a fixture project with one fake-vendor run and a published digest (publishDigest from
// @fw/daemon, FW-C-023); a real fwd serving the built web bundle (probes/lib/web.mjs), paired,
// driven with Playwright; POST /v1/kill-switch (FW-C-012); the database (an attacker write to break
// the event chain, so the daemon is degraded).
// The surface this probe expects:
//   The Dawn Log is the UI's home page (/). Every list item on it links (an <a href>) to where its
//   figure comes from: a registered query or an event (an href naming /events, /queries, or a query
//   or seq parameter).
//   At 390 x 844, with the kill switch engaged and the event chain broken, the halted state (stopped
//   or halted) and the degraded state (the chain or integrity check failing) are both inside the
//   first screen, without scrolling.
//   With fwd stopped, the page says it cannot reach fwd and labels what it still shows as not
//   current (unknown, last known, or as of a time), never as live.
//
// Proves, in order:
//   1. Every line links to its source.
//   2. Halted and degraded are visible without scrolling at 390 px.
//   3. With the daemon down the page says so and shows nothing stale as current.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  dbPath,
  fixtureProject,
  fw,
  fwJson,
  openDbAsAttacker,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  root,
} from '../c0/_lib.mjs';
import { api } from '../lib/fwd.mjs';
import { browser, pairedPage, startUi } from '../lib/web.mjs';

const SOURCE = /\/(events|queries)\b|[?&](seq|query|q|after_seq)=/;

await probe('ui/dawn-log', async () => {
  const publishDigest = await requireExport('daemon', 'publishDigest', 'FW-C-023');
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);
  const proj = fixtureProject({ rowId: 'FW-C-985' });
  const home = pipelineHome('dawn');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed');
  check(fwJson(['run', 'start', 'FW-C-985', '--adapter', 'fake'], o).status === 0, 'fw run start failed');
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 86400000);
    const p = publishDigest(store.writer, { from: from.toISOString(), to: to.toISOString() });
    check(p?.published, `the digest was not published: ${JSON.stringify(p?.problems ?? p).slice(0, 200)}`);
  } finally {
    store.close();
  }

  let ui = await startUi(home, { env });
  const br = await browser();
  try {
    // 1. Every line links to its source.
    let page = await pairedPage(ui, br, { width: 1280, height: 900 });
    await page.goto(`${ui.base}/`);
    await page.locator('main').first().waitFor({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    const lines = await page.locator('main li').evaluateAll((els) =>
      els.map((li) => ({ text: li.innerText.trim().slice(0, 60), hrefs: [...li.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) })),
    );
    check(lines.length > 0, 'the Dawn Log shows no lines');
    const unlinked = lines.filter((l) => !l.hrefs.some((h) => SOURCE.test(h)));
    check(unlinked.length === 0, `lines with no link to a query or event: ${unlinked.map((l) => JSON.stringify(l.text)).slice(0, 5).join(', ')}`);
    await page.context().close();
    await ui.stop();

    // 2. Halted and degraded, above the fold at 390.
    const attacker = await openDbAsAttacker(home);
    for (const t of attacker.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'").all()) {
      attacker.exec(`DROP TRIGGER "${t.name}"`);
    }
    const ev = attacker.prepare('SELECT seq, payload FROM events ORDER BY seq LIMIT 1 OFFSET 1').get();
    attacker.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(ev.payload.replace(/[a-z]/, (c) => (c === 'a' ? 'b' : 'a')), ev.seq);
    attacker.close();
    ui = await startUi(home, { env });
    const k = await api(ui.port, 'POST', '/v1/kill-switch', { auth: ui.token, body: { reason: 'probe: dawn log halted' } });
    check(k.status === 200, `POST /v1/kill-switch answered ${k.status}`);
    page = await pairedPage(ui, br, { width: 390, height: 844 });
    await page.goto(`${ui.base}/`);
    await page.locator('main').first().waitFor({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    const above = async (re) =>
      page.evaluate(
        (src) => {
          const rx = new RegExp(src, 'i');
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!rx.test(n.textContent)) continue;
            const r = n.parentElement.getBoundingClientRect();
            if (r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight) return true;
          }
          return false;
        },
        re.source,
      );
    check(await above(/\b(stopped|halted)\b/), 'the halted state is not visible without scrolling at 390 px');
    check(await above(/\b(chain|integrity|tamper)/), 'the degraded state (chain check failing) is not visible without scrolling at 390 px');

    // 3. Daemon down.
    await ui.stop();
    await page.getByText(/(could not|couldn't|cannot|can't) reach/i).first().waitFor({ timeout: 45000 });
    const text = await page.locator('body').innerText();
    check(/\b(unknown|last known|as of)\b/i.test(text), 'with fwd down the page does not mark what it shows as not current');
  } finally {
    await br.close();
    await ui.stop().catch(() => {});
  }
});
