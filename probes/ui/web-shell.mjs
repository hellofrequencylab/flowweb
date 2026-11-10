// Probe for FW-C-019 (web shell: pairing, status strip, kill button, PWA manifest): `pnpm probe ui/web-shell`.
// Tier 0.
// probe-timeout-s: 300
// Surfaces: a real fwd serving the built packages/web bundle (probes/lib/web.mjs, FW_WEB_DIR), driven
// with Playwright's Chromium on loopback; GET /v1/status for what the daemon says.
// The surface this probe expects:
//   fwd serves the bundle at / and index.html for every client-side path, with /manifest.webmanifest
//   (application/manifest+json) linked from index.html.
//   An unpaired browser sees only the pairing screen ("Pair this browser"), on any path: no navigation
//   and no kill switch. Entering the code fwd printed pairs it (POST /v1/pair) and shows the app.
//   Chromium's installability check (Page.getInstallabilityErrors) reports no errors on loopback.
//   Holding the top bar's Stop ("Stop everything: press and hold") engages the kill switch through
//   POST /v1/kill-switch; the strip shows the stopped state only once the daemon has answered, never
//   while the request is in flight.
//
// Proves, in order:
//   1. Unpaired: only the pairing screen, on / and on /ledger.
//   2. Pairing with the printed code shows the app.
//   3. The installability check passes.
//   4. The kill button engages the switch through the API, and "Stopped" appears only after fwd confirms.
import { check, freshHome, probe, sleep } from '../c0/_lib.mjs';
import { api } from '../lib/fwd.mjs';
import { browser, startUi } from '../lib/web.mjs';

await probe('ui/web-shell', async () => {
  const home = freshHome('shell');
  const ui = await startUi(home);
  const br = await browser();
  try {
    // 1. Unpaired.
    const page = await br.newPage({ width: 1280, height: 900 });
    for (const path of ['/', '/ledger']) {
      await page.goto(ui.base + path);
      await page.getByRole('heading', { name: /pair this browser/i }).waitFor({ timeout: 15000 });
      check((await page.getByRole('navigation').count()) === 0, `an unpaired browser sees navigation on ${path}`);
      check((await page.getByRole('button', { name: /stop/i }).count()) === 0, `an unpaired browser sees the kill switch on ${path}`);
    }

    // 2. Pair through the UI.
    await page.getByLabel(/pairing code/i).fill(ui.pairingCode ?? '');
    await page.getByRole('button', { name: /^pair$/i }).click();
    await page.getByRole('navigation').first().waitFor({ timeout: 15000 });
    check((await page.getByRole('heading', { name: /pair this browser/i }).count()) === 0, 'the pairing screen stayed after pairing');

    // 3. Installability.
    const manifest = await api(ui.port, 'GET', '/manifest.webmanifest');
    check(manifest.status === 200 && /manifest\+json|application\/json/.test(String(manifest.headers['content-type'])), `GET /manifest.webmanifest answered ${manifest.status} ${manifest.headers['content-type']}`);
    const cdp = await page.context().newCDPSession(page);
    const inst = await cdp.send('Page.getInstallabilityErrors');
    const errs = (inst.installabilityErrors ?? []).map((e) => e.errorId);
    check(errs.length === 0, `the installability check failed: ${errs.join(', ')}`);

    // 4. Kill button, with the API answer held back for 2 s.
    let posted = false;
    let answered = false;
    await page.route('**/v1/kill-switch', async (route) => {
      posted = true;
      await sleep(2000);
      const res = await route.fetch();
      answered = true;
      await route.fulfill({ response: res });
    });
    const stop = page.getByRole('button', { name: /stop everything: press and hold/i });
    await stop.waitFor({ timeout: 10000 });
    await stop.hover();
    await page.mouse.down();
    await sleep(2500);
    await page.mouse.up();
    const stopped = page.getByText(/^(stopped|everything is stopped)$/i);
    const t0 = Date.now();
    while (!answered && Date.now() - t0 < 10000) {
      check(!((await stopped.count()) > 0 && !answered), 'the strip showed stopped before fwd answered');
      await sleep(100);
    }
    check(posted, 'holding Stop did not call POST /v1/kill-switch');
    await stopped.first().waitFor({ timeout: 10000 });
    const st = await api(ui.port, 'GET', '/v1/status', { auth: ui.token });
    check(st.json?.data?.kill?.engaged === true, 'the UI shows stopped but fwd does not report the kill switch engaged');
  } finally {
    await br.close();
    await ui.stop();
  }
});
