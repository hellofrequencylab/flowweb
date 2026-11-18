// Probe for FW-C-165 (every flow can be edited on the site, and a built profile can be switched on there):
// `pnpm probe flows/edit-every-flow`.
// Tier 0. Committed with the Owner's approval (decision card, 2026-11-18).
// probe-timeout-s: 300
// Surfaces: a real fwd on a fresh FW_HOME with FW_VENDOR=fake, the CLI token, GET /v1/flows/{key}/profiles,
// POST /v1/supervisor/flows/{base}/copy, GET /v1/supervisor; hosted/server/requests.mjs (pure); and
// packages/web/src/flows/ActivationPage.tsx and FlowsHome.tsx, rendered by probes/flows/edit-every-flow.spec.tsx
// with vitest in jsdom against a fetch stub that replays what the real fwd above answered.
//
// Proves, in order:
//   1. On a fresh fwd the profiles route lists every profile the main flow ships, none of them made. After
//      a copy from the studios profile it marks that one made, and the new flow is off, on Draft. A copy
//      and a flow that ships no profiles answer 404.
//   2. The site accepts POST /supervisor/flows/neighborhood-activation/copy { profile } as a flow.copy
//      request and the relay's call to fwd carries the profile; a profile that is not a slug is refused.
//   3. The component checks pass (3 of them): the main flow's page shows the targeting editor and says the
//      flow follows its built-in brief; the Flows page lists the profiles not made yet, each with a Switch
//      on button, and leaves out the one already made; pressing Switch on posts the copy request with that
//      profile and links to the new flow's page.
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/edit-every-flow';
const BASE = 'neighborhood-activation';
const MADE = `${BASE}--studios`;

await probe(NAME, async () => {
  // ---- 1. the profiles route, on a real fwd ------------------------------------------------------------
  const home = realpathSync(freshHome('edit-every-flow'));
  const f = await startFwd(home, { env: { FW_VENDOR: 'fake' } });
  const recorded = {};
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, ...(body === undefined ? {} : { body }) });
    const shipped = readdirSync(join(root, 'flows', BASE, 'profiles')).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5)).sort();
    const fresh = await call('GET', `/v1/flows/${BASE}/profiles`);
    if (fresh.status === 404) missing(`GET /v1/flows/${BASE}/profiles answers 404: fwd does not list a flow's profiles (row FW-C-165)`);
    check(fresh.status === 200 && Array.isArray(fresh.json?.data), `the profiles list answered ${fresh.status}: ${fresh.text.slice(0, 200)}`);
    check(JSON.stringify(fresh.json.data.map((p) => p.slug)) === JSON.stringify(shipped), `the list names ${fresh.json.data.map((p) => p.slug)}, the flow ships ${shipped}`);
    check(fresh.json.data.every((p) => p.copy_key === null && typeof p.name === 'string' && p.name !== '' && typeof p.note === 'string'), 'a fresh fwd lists a profile as made, or one without a name');

    const made = await call('POST', `/v1/supervisor/flows/${BASE}/copy`, { profile: 'studios' });
    check(made.status === 200 && made.json?.data?.key === MADE, `making the studios flow answered ${made.status}: ${made.text.slice(0, 200)}`);
    const sup = await call('GET', '/v1/supervisor');
    const flow = sup.json?.data?.flows?.find((x) => x.key === MADE);
    check(flow && flow.enabled === false && flow.dial === 'draft', `the new flow must start off, on Draft; it reads ${JSON.stringify(flow && { enabled: flow.enabled, dial: flow.dial })}`);
    const after = await call('GET', `/v1/flows/${BASE}/profiles`);
    const by = Object.fromEntries(after.json.data.map((p) => [p.slug, p.copy_key]));
    check(by.studios === MADE, `after the copy, studios reads copy_key ${by.studios}, want ${MADE}`);
    check(shipped.every((s) => s === 'studios' || by[s] === null), 'making one profile marked another as made');
    check((await call('GET', `/v1/flows/${MADE}/profiles`)).status === 404, 'a copy lists profiles of its own');
    check((await call('GET', '/v1/flows/paid-ads/profiles')).status === 404, 'a flow that ships no profiles lists some');

    for (const path of ['/v1/supervisor', `/v1/flows/${BASE}`, `/v1/flows/${BASE}/targeting`, `/v1/flows/${BASE}/profiles`, `/v1/flows/${BASE}/hunts`]) {
      const got = await call('GET', path);
      check(got.status === 200, `GET ${path} answered ${got.status}`);
      recorded[path] = got.json;
    }
    check(recorded[`/v1/flows/${BASE}/targeting`].data.has_playbook === false, 'the main flow reads as having a playbook on a fresh fwd');
  } finally {
    await f.stop();
  }

  // ---- 2. the site carries the profile ---------------------------------------------------------------------
  const { requestOf, fwdCallFor } = await import(pathToFileURL(join(root, 'hosted/server/requests.mjs')).href);
  const r = requestOf('POST', `/supervisor/flows/${BASE}/copy`, { profile: 'studios' });
  check(r && r.kind === 'flow.copy' && r.flow === BASE, `the site reads the copy as ${JSON.stringify(r)}`);
  check(r.payload?.profile === 'studios', `the site's flow.copy request drops the profile: ${JSON.stringify(r.payload)}`);
  const to = fwdCallFor({ id: 'r1', ...r });
  check(to && to.method === 'POST' && to.path === `/supervisor/flows/${BASE}/copy` && to.body?.profile === 'studios', `the relay's call does not carry the profile: ${JSON.stringify(to)}`);
  for (const bad of ['Bad Slug', '../studios', 'x'.repeat(31)])
    check(requestOf('POST', `/supervisor/flows/${BASE}/copy`, { profile: bad })?.error, `the site accepted the profile ${JSON.stringify(bad)}`);

  // ---- 3. the pages ----------------------------------------------------------------------------------------
  const tmp = realpathSync(tmpDir('edit-every-flow'));
  const fixture = join(tmp, 'fwd.json');
  writeFileSync(fixture, JSON.stringify(recorded));
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmp, 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/edit-every-flow.spec.tsx')], testTimeout: 60000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const v = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 200000,
    env: { ...process.env, CI: '1', NO_COLOR: '1', FW_PROBE_FIXTURE: fixture },
  });
  const out = `${v.stdout ?? ''}${v.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(v.status === 0, `the page checks failed (exit ${v.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+3 passed/.test(out), `expected 3 page checks to pass:\n${out.slice(-400)}`);
});
