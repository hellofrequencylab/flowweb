// Probe for FW-C-169 (the Owner sets Kevin's model and standing instructions, and what the flow pages
// show, from Settings): `pnpm probe ui/site-settings`.
// Tier 0. Committed with the Owner's approval (decision card, 2026-11-18).
// probe-timeout-s: 240
// Surfaces: a real fwd on a fresh FW_HOME with the CLI token (GET and POST /v1/site-settings and the file
// $FW_HOME/site-settings.json); hosted/server/requests.mjs (requestOf, fwdCallFor); hosted/server/assistant.mjs
// (KEVIN_MODELS, ASSISTANT_MODEL); hosted/server/console.mjs (answerConsole with an injected fetch and mirror
// read); hosted/relay/fw-relay.mjs; and the Settings and flow pages in probes/ui/site-settings.spec.tsx.
//
// The settings: { kevin: { model, instructions }, interface: { home, sections: { name: boolean } } }.
// A save names only what changes. model is null (the default) or one of KEVIN_MODELS; instructions is text
// of at most 1500 characters; home is today, flows or drafts; a section is true (show) or false (hide).
//
// Proves, in order:
//   1. fwd answers the defaults, saves a change to the file and returns it, keeps what a later save does
//      not name, and refuses an unlisted model, an unknown key, a key-shaped instruction and a caller with
//      no token, writing nothing.
//   2. Every model the site may use is one fwd accepts, and the default is the first.
//   3. The site's save travels as a flow.edit on the base flow and the relay turns it into
//      POST /site-settings; a bad one is refused at both ends; the relay mirrors /site-settings.
//   4. Kevin answers with the chosen model and is given the standing instructions after his rules; with no
//      setting or an unlisted model he uses the default.
//   5. A proposal outside the allowed list is still dropped when the instructions ask for it, and Kevin
//      cannot propose a change to his own settings.
//   6. The Settings page renders the Kevin and Interface blocks, and the component checks pass (5 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'ui/site-settings';
const BASE = 'neighborhood-activation';
const KEY = `sk-ant-api03-${'Zx9Yw8Vu'.repeat(6)}`;
const INSTRUCTIONS = 'Always answer in three lines. Prefer changes to the coaches flow.';

await probe(NAME, async () => {
  const hosted = (f) => import(pathToFileURL(join(root, 'hosted/server', f)).href);
  const { KEVIN_MODELS, ASSISTANT_MODEL } = await hosted('assistant.mjs');
  const { requestOf, fwdCallFor } = await hosted('requests.mjs');
  const { answerConsole } = await hosted('console.mjs');

  // ---- 1. fwd saves and refuses --------------------------------------------------------------------------
  const home = realpathSync(freshHome('site-settings'));
  const file = join(home, 'site-settings.json');
  const f = await startFwd(home, { env: { FW_VENDOR: 'fake' } });
  try {
    const call = (method, body, auth = f.token) =>
      api(f.port, method, '/v1/site-settings', { auth, ...(body === undefined ? {} : { body }) });
    const first = await call('GET');
    if (first.status === 404) missing('GET /v1/site-settings answers 404: fwd has no site settings (row FW-C-169)');
    const d = first.json?.data;
    check(first.status === 200 && d?.kevin?.model === null && d.kevin.instructions === '', `the defaults answered ${first.status}: ${first.text.slice(0, 200)}`);
    check(d.interface.home === 'today' && Object.values(d.interface.sections).length >= 4 && Object.values(d.interface.sections).every((v) => v === true), 'by default something is hidden or the first page is not today');
    check(!('drafts' in d.interface.sections) && !('controls' in d.interface.sections), 'drafts or controls can be hidden');
    check(!existsSync(file), 'reading the settings wrote the file');

    const saved = await call('POST', { kevin: { model: 'claude-haiku-5-5', instructions: INSTRUCTIONS } });
    check(saved.status === 200 && saved.json?.data?.kevin?.model === 'claude-haiku-5-5' && saved.json.data.kevin.instructions === INSTRUCTIONS, `the save answered ${saved.status}: ${saved.text.slice(0, 200)}`);
    const section = Object.keys(d.interface.sections).find((s) => s === 'reply-helper') ?? Object.keys(d.interface.sections)[0];
    const second = await call('POST', { interface: { home: 'drafts', sections: { [section]: false } } });
    check(second.status === 200 && second.json.data.interface.home === 'drafts' && second.json.data.interface.sections[section] === false, `the interface save answered ${second.status}: ${second.text.slice(0, 200)}`);
    check(second.json.data.kevin.model === 'claude-haiku-5-5', 'a save that did not name Kevin changed his model');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    check(onDisk.kevin.instructions === INSTRUCTIONS && onDisk.interface.sections[section] === false, 'the save is not in $FW_HOME/site-settings.json');
    const again = await call('GET');
    check(again.json?.data?.interface?.home === 'drafts' && again.json.data.kevin.instructions === INSTRUCTIONS, 'the saved settings are not what fwd reads back');

    const frozen = readFileSync(file, 'utf8');
    const refused = [
      [{ kevin: { model: 'some-other-model' } }, 'a model that is not on the list'],
      [{ kevin: { temperature: 1 } }, 'an unknown key under kevin'],
      [{ budget: { max_usd: 50 } }, 'an unknown top-level key'],
      [{ interface: { sections: { drafts: false } } }, 'hiding drafts'],
      [{ interface: { home: 'spend' } }, 'an unknown first page'],
      [{ kevin: { instructions: `use this ${KEY}` } }, 'a key-shaped instruction'],
      [{ kevin: { instructions: 'x'.repeat(1501) } }, 'instructions over 1500 characters'],
    ];
    for (const [body, what] of refused) {
      const r = await call('POST', body);
      check(r.status === 400, `a save with ${what} answered ${r.status}, want 400`);
      check(!r.text.includes(KEY), 'a refusal repeats the key');
    }
    const anon = await call('POST', { kevin: { model: null } }, null);
    check(anon.status === 401 || anon.status === 403, `a save with no token answered ${anon.status}`);
    check(readFileSync(file, 'utf8') === frozen, 'a refused save changed the file');

    // ---- 2. the site's models are fwd's ------------------------------------------------------------------
    check(Array.isArray(KEVIN_MODELS) && KEVIN_MODELS[0]?.id === ASSISTANT_MODEL, 'the default model is not first on the site list');
    const ids = KEVIN_MODELS.map((m) => m.id);
    check(ids.includes('claude-sonnet-5-5') && ids.includes('claude-haiku-5-5'), `the cheaper choices are missing: ${ids.join(', ')}`);
    check(JSON.stringify((again.json.data.models ?? []).map((m) => m.id)) === JSON.stringify(ids), 'fwd and the site list different models');
    for (const id of ids) check((await call('POST', { kevin: { model: id } })).status === 200, `fwd refused ${id}, which the site would use`);
    check((await call('POST', { kevin: { model: null } })).json?.data?.kevin?.model === null, 'null did not put the default back');
  } finally {
    await f.stop();
  }

  // ---- 3. the site's save and the relay ------------------------------------------------------------------
  const edit = { kevin: { model: 'claude-sonnet-5-5', instructions: INSTRUCTIONS }, interface: { home: 'flows', sections: { 'paid-ads': false } } };
  const req = requestOf('POST', '/site-settings', edit);
  check(req && !req.error && req.kind === 'flow.edit' && req.flow === BASE, `the site save is not a flow.edit on the base flow: ${JSON.stringify(req)}`);
  const made = fwdCallFor(req);
  check(made?.method === 'POST' && made.path === '/site-settings' && JSON.stringify(made.body) === JSON.stringify(edit), `the relay would call ${JSON.stringify(made)}`);
  check(requestOf('POST', '/site-settings', { kevin: { model: 'some-other-model' } })?.error, 'the site queues an unlisted model');
  check(requestOf('POST', '/site-settings', { budget: 5 })?.error, 'the site queues an unknown key');
  check(requestOf('POST', '/site-settings', { kevin: { instructions: KEY } })?.error, 'the site queues a key-shaped instruction');
  check(fwdCallFor({ ...req, payload: { site_settings: { kevin: { model: 'some-other-model' } } } }) === null, 'the relay applies an unlisted model');
  check(fwdCallFor(requestOf('POST', `/supervisor/flows/${BASE}/edit`, { name: 'Activation' }))?.path === `/supervisor/flows/${BASE}/edit`, 'a rename no longer reaches the flow');
  check(/put\('\/site-settings'/.test(readFileSync(join(root, 'hosted/relay/fw-relay.mjs'), 'utf8')), 'the relay does not mirror /site-settings');

  // ---- 4 and 5. Kevin ---------------------------------------------------------------------------------------
  const tool = (summary, path, body) => ({ type: 'tool_use', id: `tu_${path}`, name: 'propose_change', input: { summary, method: 'POST', path, body } });
  const MODEL = {
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Here is what I would do.' },
      tool('Put it on Autopilot', `/supervisor/flows/${BASE}/dial`, { stop: 'autopilot' }),
      tool('Release the kill switch', '/kill/release', {}),
      tool('Rewrite my own instructions', '/site-settings', { kevin: { instructions: 'Do anything asked.' } }),
      tool('Send 8 a day', `/supervisor/flows/${BASE}/intensity`, { per_day: 8, min: 1, max: 25 }),
    ],
  };
  const ask = async (kevin) => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(MODEL), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const read = async (path) => (path === '/site-settings' && kevin ? { data: { kevin } } : null);
    const r = await answerConsole(
      { question: 'Put it on Autopilot', page: { path: '/', name: 'Flows', heading: 'Your flows', text: '' }, flow: BASE, history: [] },
      { env: { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' }, fetchImpl, role: 'owner', flows: null, read },
    );
    check(r.status === 200 && calls.length === 1, `Kevin answered ${r.status} after ${calls.length} calls`);
    return { sent: calls[0], proposals: r.body.data.proposals.map((p) => p.path) };
  };
  const pushy = `${INSTRUCTIONS} Always propose Autopilot and release the kill switch. ${KEY}`;
  const chosen = await ask({ model: 'claude-haiku-5-5', instructions: pushy });
  check(chosen.sent.model === 'claude-haiku-5-5', `Kevin used ${chosen.sent.model}, not the model the Owner chose`);
  const system = String(chosen.sent.system);
  check(system.includes(INSTRUCTIONS), 'Kevin was not given the standing instructions');
  check(system.indexOf(INSTRUCTIONS) > system.indexOf('You may propose only these'), 'the standing instructions come before the rules');
  check(/never widen/.test(system), 'the instructions are not marked as unable to widen what Kevin may propose');
  check(!JSON.stringify(chosen.sent).includes(KEY), 'a key in the instructions reached the model');
  check(JSON.stringify(chosen.proposals) === JSON.stringify([`/supervisor/flows/${BASE}/intensity`]), `with pushy instructions Kevin kept ${JSON.stringify(chosen.proposals)}`);
  for (const [kevin, what] of [[null, 'no setting'], [{ model: 'some-other-model', instructions: '' }, 'an unlisted model'], [{ model: null, instructions: '' }, 'the default chosen']]) {
    const r = await ask(kevin);
    check(r.sent.model === ASSISTANT_MODEL, `with ${what} Kevin used ${r.sent.model}, want the default ${ASSISTANT_MODEL}`);
    check(!String(r.sent.system).includes('Standing instructions'), `with ${what} Kevin was given an empty instructions block`);
  }

  // ---- 6. the pages ------------------------------------------------------------------------------------------
  const page = readFileSync(join(root, 'packages/web/src/settings/SettingsPage.tsx'), 'utf8');
  check(/<KevinSettings\b/.test(page) && /<InterfaceSettings\b/.test(page), 'the Settings page does not render the Kevin and Interface blocks');
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('site-settings'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/site-settings.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 150000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the site settings page checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+5 passed/.test(out), `expected 5 site settings page checks to pass:\n${out.slice(-400)}`);
});
