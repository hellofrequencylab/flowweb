// Probe for FW-C-118 (turn Frequency funnel page links on or off from Settings): `pnpm probe flows/funnels-switch`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: packages/daemon/src/flows/live-links.ts (funnelsLive, setFunnelsSettingReader), hunts.ts
// (funnelLink), a real fwd on a fresh FW_HOME (CLI token and a paired browser session) with
// flows/neighborhood-activation as shipped (its reply tree), hosted/server/requests.mjs (pure),
// hosted/supabase/migrations/0012_flowweb_funnels_switch.sql, and the Settings section
// packages/web/src/settings/FunnelsSwitch.tsx rendered by SettingsPage.tsx (its checks are in
// probes/flows/funnels-switch.spec.tsx, vitest in jsdom against a fetch stub).
//
// The surface this probe expects:
//   funnelsLive(cfg, env, setting?) answers setting when it is true or false, else today's env-then-config
//     answer. setFunnelsSettingReader(read) makes read() the default setting for every caller; null clears it.
//   POST /v1/supervisor/funnels-live { live: true | false | null } (CLI token or paired session) stores the
//     switch; GET /v1/supervisor/funnels-live answers { live, source: setting | env | config, setting,
//     env_off }, and GET /v1/supervisor carries the same object as funnels_live. Bad input 400, no session 401.
//   A stored switch wins over FW_FUNNELS_LIVE in fwd's environment: the reply helper's drafted links
//     (POST /v1/flows/{key}/replies) follow it.
//   requestOf: POST /supervisor/funnels-live -> links.funnels, flow all, payload { live }; fwdCallFor maps it
//     back; migration 0012 allows links.funnels and every kind 0011 allowed.
//
// Proves, in order:
//   1. funnelsLive takes the stored setting over env and config; a hunt link follows the registered reader.
//   2. A real fwd started with FW_FUNNELS_LIVE=on drafts /create-a-space links once the switch is off.
//   3. The same home started with FW_FUNNELS_LIVE=off drafts /for/<niche> links once the switch is on, and
//      clearing it hands the choice back to the env var.
//   4. The site queues links.funnels, the relay calls the same route with the same body, migration 0012 allows it.
//   5. Settings renders the switch and its checks pass (3 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/funnels-switch';
const KEY = 'neighborhood-activation';
const S = '/v1/supervisor/funnels-live';
const MIGRATION = 'hosted/supabase/migrations/0012_flowweb_funnels_switch.sql';
const EARLIER = 'hosted/supabase/migrations/0011_flowweb_flow_admin.sql';
const NOT_LIVE = /^\/(start\/host|start\/partner|for\/|launch)/;
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const linksOf = (text) =>
  (String(text ?? '').match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map((l) => new URL(l.replace(/[.,]+$/, '')));

await probe(NAME, async () => {
  // ---- 1. the stored setting wins over env and config ----------------------------------------------------
  const ll = await imp('packages/daemon/src/flows/live-links.ts');
  if (typeof ll.setFunnelsSettingReader !== 'function')
    missing('live-links.ts does not export setFunnelsSettingReader (row FW-C-118)');
  check(ll.funnelsLive({ funnels_live: true }, { FW_FUNNELS_LIVE: 'on' }, false) === false, 'a stored off did not win over env on and config true');
  check(ll.funnelsLive({ funnels_live: false }, { FW_FUNNELS_LIVE: 'off' }, true) === true, 'a stored on did not win over env off and config false');
  check(ll.funnelsLive({ funnels_live: true }, { FW_FUNNELS_LIVE: 'off' }, null) === false, 'unset no longer falls back to the env var');
  check(ll.funnelsLive({ funnels_live: false }, {}) === false && ll.funnelsLive({}, {}) === true, 'unset no longer falls back to the config');
  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  const hunts = await imp('packages/daemon/src/flows/hunts.ts');
  const hunt = { id: 'hnt_1', region: cfg.seed_territory_id, areas: ['encinitas'] };
  try {
    ll.setFunnelsSettingReader(() => false);
    const off = new URL(hunts.funnelLink({ ...cfg, funnels_live: true }, hunt, { niche: 'sound' }));
    check(off.pathname === '/create-a-space', `with the switch off a hunt link goes to ${off.pathname}`);
    check(off.searchParams.get('utm_source') === 'flowweb' && off.searchParams.get('niche') === 'sound', `a hunt link lost its tags: ${off}`);
    ll.setFunnelsSettingReader(() => true);
    const on = new URL(hunts.funnelLink({ ...cfg, funnels_live: false }, hunt, { niche: 'sound' }));
    check(on.pathname === (cfg.dm_door?.path ?? cfg.funnels.host.path), `with the switch on a hunt link goes to ${on.pathname}`);
  } finally {
    ll.setFunnelsSettingReader(null);
  }

  // ---- 2 and 3. a real fwd, both ways round ---------------------------------------------------------------
  const home = realpathSync(freshHome('funnels-switch'));
  const reply = async (f, auth) => {
    const r = await api(f.port, 'POST', `/v1/flows/${KEY}/replies`, {
      auth,
      body: { text: 'Yes, sounds good. I teach yoga classes on Saturdays.', contact: 'teacher@example.com' },
    });
    check(r.status === 200, `the reply helper answered ${r.status}: ${r.text.slice(0, 200)}`);
    const body = r.json?.data?.draft?.body;
    const links = linksOf(body).filter((u) => u.searchParams.get('utm_source') === 'flowweb');
    check(links.length > 0, `the drafted reply has no tagged link: ${body}`);
    return links;
  };
  const view = async (f) => {
    const g = await api(f.port, 'GET', S, { auth: f.token });
    check(g.status === 200, `GET ${S} answered ${g.status}: ${g.text.slice(0, 200)}`);
    return g.json?.data;
  };

  let f = await startFwd(home, { env: { FW_FUNNELS_LIVE: 'on' } });
  try {
    const before = await view(f);
    check(before?.source === 'config' && before?.setting === null, `before any choice GET says ${JSON.stringify(before)}`);
    const none = await api(f.port, 'POST', S, { body: { live: false } });
    check(none.status === 401, `no session answered ${none.status}, want 401`);
    const { cookie } = await pair(f.port, f.pairingCode);
    const set = await api(f.port, 'POST', S, { auth: { cookie }, body: { live: false } });
    check(set.status === 200, `turning it off answered ${set.status}: ${set.text.slice(0, 200)}`);
    const bad = await api(f.port, 'POST', S, { auth: { cookie }, body: { live: 'yes' } });
    check(bad.status === 400, `a bad value answered ${bad.status}, want 400`);
    const after = await view(f);
    check(after?.live === false && after?.source === 'setting' && after?.setting === false, `after off GET says ${JSON.stringify(after)}`);
    const sup = (await api(f.port, 'GET', '/v1/supervisor', { auth: f.token })).json?.data;
    check(sup?.funnels_live?.live === false && sup?.funnels_live?.source === 'setting', `GET /v1/supervisor funnels_live is ${JSON.stringify(sup?.funnels_live)}`);
    const links = await reply(f, f.token);
    for (const u of links) check(!NOT_LIVE.test(u.pathname), `with the switch off and FW_FUNNELS_LIVE=on a reply links to ${u}`);
    check(links.some((u) => u.pathname === '/create-a-space'), `no reply link goes to /create-a-space: ${links.join(' ')}`);
  } finally {
    await f.stop();
  }

  f = await startFwd(home, { env: { FW_FUNNELS_LIVE: 'off' } });
  try {
    const kept = await view(f);
    check(kept?.setting === false && kept?.source === 'setting', `the switch did not survive a restart: ${JSON.stringify(kept)}`);
    const on = await api(f.port, 'POST', S, { auth: f.token, body: { live: true } });
    check(on.status === 200, `turning it on answered ${on.status}: ${on.text.slice(0, 200)}`);
    const links = await reply(f, f.token);
    check(links.some((u) => u.pathname === '/for/teacher'), `with the switch on and FW_FUNNELS_LIVE=off no reply links to /for/teacher: ${links.join(' ')}`);
    const clear = await api(f.port, 'POST', S, { auth: f.token, body: { live: null } });
    check(clear.status === 200, `clearing it answered ${clear.status}: ${clear.text.slice(0, 200)}`);
    const back = await view(f);
    check(back?.setting === null && back?.source === 'env' && back?.live === false && back?.env_off === true, `after clearing GET says ${JSON.stringify(back)}`);
    for (const u of await reply(f, f.token)) check(!NOT_LIVE.test(u.pathname), `cleared with FW_FUNNELS_LIVE=off a reply links to ${u}`);
  } finally {
    await f.stop();
  }

  // ---- 4. the site queue and migration 0012 ----------------------------------------------------------------
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const P = '/supervisor/funnels-live';
  for (const live of [true, false, null]) {
    const r = requestOf('POST', P, { live, extra: 'dropped' });
    check(r && !r.error && r.kind === 'links.funnels' && r.flow === 'all', `POST ${P} ${live} became ${JSON.stringify(r)}`);
    check(JSON.stringify(r.payload) === JSON.stringify({ live }), `links.funnels carries ${JSON.stringify(r.payload)}, want only live`);
    const call = fwdCallFor({ id: 'r1', ...r });
    check(call?.method === 'POST' && call.path === P && JSON.stringify(call.body) === JSON.stringify({ live }), `the relay calls ${JSON.stringify(call)}`);
  }
  check(requestOf('POST', P, { live: 'yes' })?.error, 'a bad value was queued');
  check(requestOf('POST', P, {})?.error, 'a missing value was queued');
  check(fwdCallFor({ id: 'r2', kind: 'links.funnels', flow: 'all', payload: { live: 'yes' } }) === null, 'the relay would apply a bad value');
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-118)`);
  const sql = readFileSync(mig, 'utf8');
  const earlier = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  check(earlier.length >= 20, `read only ${earlier.length} kinds from ${EARLIER}`);
  for (const k of [...new Set([...earlier, 'links.funnels'])]) check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);
  check(/drop constraint if exists fw_requests_kind_check/.test(sql), `${MIGRATION} does not replace fw_requests_kind_check`);

  // ---- 5. Settings -----------------------------------------------------------------------------------------
  const page = readFileSync(join(root, 'packages/web/src/settings/SettingsPage.tsx'), 'utf8');
  if (!/<FunnelsSwitch\b/.test(page)) missing('the Settings page does not render <FunnelsSwitch> (row FW-C-118)');
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('funnels-switch'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/funnels-switch.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const out = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfgFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const failed = text.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(out.status === 0, `the Settings checks failed (exit ${out.status}):\n${failed.join('\n') || text.slice(-800)}`);
  check(/Tests\s+3 passed/.test(text), `expected 3 Settings checks to pass:\n${text.slice(-400)}`);
});
