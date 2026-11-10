// Shared helper for the UI probes (C2). Tier 0, not a row probe.
// buildWeb() builds packages/web once per process into a scratch directory. startUi(home) starts a real
// fwd that serves that bundle (FW_WEB_DIR) next to /v1 on loopback; the UI is MISSING until fwd serves
// it (row FW-C-019). browser() launches Playwright's Chromium, from the repo or the global install, and
// axe() runs axe-core on a page.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { check, fail, missing, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from './fwd.mjs';

let built;

/** Builds the web bundle into a scratch directory (once per process) and returns its path. */
export function buildWeb() {
  if (built) return built;
  const out = tmpDir('web');
  const r = spawnSync(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: join(root, 'packages/web'),
    encoding: 'utf8',
    timeout: 180000,
  });
  if (r.status !== 0) {
    const local = spawnSync(join(root, 'packages/web/node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: join(root, 'packages/web'),
      encoding: 'utf8',
      timeout: 180000,
    });
    if (local.status !== 0) fail(`the web bundle does not build: ${(local.stderr || r.stderr).trim().split('\n')[0]}`);
  }
  check(existsSync(join(out, 'index.html')), 'the web build wrote no index.html');
  built = out;
  return out;
}

/**
 * Starts fwd for this home serving the built UI. Returns the fwd handle plus base (the UI origin).
 * MISSING when GET / does not answer the bundle's index.html.
 */
export async function startUi(home, { env = {}, args = [], port } = {}) {
  const dir = buildWeb();
  const fwd = await startFwd(home, { env: { FW_WEB_DIR: dir, ...env }, args, port });
  const page = await api(fwd.port, 'GET', '/');
  if (page.status !== 200 || !/text\/html/.test(String(page.headers['content-type'])) || !page.text.includes('<div id="root"')) {
    await fwd.stop();
    missing(`fwd does not serve the web UI at / from FW_WEB_DIR (got ${page.status}; row FW-C-019)`);
  }
  const deep = await api(fwd.port, 'GET', '/ledger');
  if (deep.status !== 200 || !deep.text.includes('<div id="root"')) {
    await fwd.stop();
    missing('fwd does not serve index.html for a client-side path such as /ledger (row FW-C-019)');
  }
  return { ...fwd, base: `http://127.0.0.1:${fwd.port}` };
}

function loadPlaywright() {
  const tries = [() => createRequire(join(root, 'package.json'))('playwright')];
  try {
    const g = execSync('npm root -g', { encoding: 'utf8' }).trim();
    tries.push(() => createRequire(join(g, 'noop.js'))('playwright'));
  } catch {}
  for (const t of tries) {
    try {
      return t();
    } catch {}
  }
  missing('Playwright is not installed (neither in the repo nor globally)');
}

/** Launches Chromium. Returns { browser, newPage({ width, height }), close }. */
export async function browser() {
  const { chromium } = loadPlaywright();
  const b = await chromium.launch();
  return {
    browser: b,
    async newPage({ width = 1280, height = 900 } = {}) {
      const ctx = await b.newContext({ viewport: { width, height } });
      return ctx.newPage();
    },
    close: () => b.close(),
  };
}

/** A paired browser page: trades the pairing code for the fw_session cookie and sets it. */
export async function pairedPage(ui, br, size) {
  const { cookie } = await pair(ui.port, ui.pairingCode);
  const [name, value] = cookie.split('=');
  const page = await br.newPage(size);
  await page.context().addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  page.fwErrors = [];
  page.on('pageerror', (e) => page.fwErrors.push(e.message));
  return page;
}

/** Opens a path and returns the text of <main> once the page has settled; fails on a script error. */
export async function mainText(page, url) {
  if (url) await page.goto(url);
  await page.locator('main').first().waitFor({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  const errs = page.fwErrors ?? [];
  check(errs.length === 0, `${page.url()} threw: ${errs.join('; ').slice(0, 300)}`);
  check((await page.locator('main').count()) === 1, `${page.url()} lost its main content`);
  return page.locator('main').innerText();
}

/** axe-core's source from the repo; MISSING when it is not a dependency. */
export function axeSource() {
  for (const p of [join(root, 'node_modules/axe-core/axe.min.js'), join(root, 'packages/web/node_modules/axe-core/axe.min.js')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  missing('axe-core is not installed in the repo (node_modules/axe-core)');
}

/** Runs axe on the page; returns the violations whose impact is serious or critical. */
export async function axeSerious(page, source) {
  await page.addScriptTag({ content: source });
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  });
  return res.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}
