// Probe for FW-C-092 (an AI console at the bottom right of every page that knows the page and flow,
// answers questions, and changes a flow only after the person confirms): `pnpm probe ui/ai-console`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/console/Console.tsx, rendered by packages/web/src/shell/App.tsx for a signed-in
// session, and hosted/server/console.mjs, which api/v1.mjs serves as POST /v1/assistant/console.
//
// The server's surface:
//   answerConsole(body, { env, fetchImpl, role, flows, read }) answers { status, body }.
//   body is { question, page: { path, name, heading, text }, flow, history: [{ who: 'you' | 'ai', text }] }.
//   read(path) answers the mirrored envelope for a /v1 GET path, or null.
//   A 200 body is { data: { answer, proposals: [{ id, summary, method, path, body, kind, flow }], can_change } }.
//   The model proposes a change with a tool_use block named propose_change, input { summary, method, path, body }.
// The page's surface is in probes/ui/ai-console.spec.tsx (vitest, jsdom, a fetch stub for the site).
//
// Proves, in order:
//   1. Console.tsx exists, App.tsx renders <Console, and api/v1.mjs routes /assistant/console to answerConsole.
//   2. The server refuses a key-shaped question before any call, answers 503 not_configured without
//      FW_ASSISTANT_ANTHROPIC_KEY, and sends the key only as a header.
//   3. The model is given the page, the selected flow and that flow's review summary from the mirror.
//   4. A proposal is kept only when hosted/server/requests.mjs requestOf accepts it (Autopilot and unknown
//      paths are dropped); a viewer gets none and can_change false; a helper gets none outside their flows.
//   5. The component checks pass (8 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/ai-console';
const FLOW = 'neighborhood-activation';

await probe(NAME, async () => {
  // 1. Wiring.
  if (!existsSync(join(root, 'packages/web/src/console/Console.tsx')))
    missing('packages/web/src/console/Console.tsx does not exist (row FW-C-092)');
  const app = readFileSync(join(root, 'packages/web/src/shell/App.tsx'), 'utf8');
  check(/<Console\b/.test(app), 'packages/web/src/shell/App.tsx does not render <Console> (row FW-C-092)');
  const server = join(root, 'hosted/server/console.mjs');
  if (!existsSync(server)) missing('hosted/server/console.mjs does not exist (row FW-C-092)');
  const v1 = readFileSync(join(root, 'api/v1.mjs'), 'utf8');
  check(
    /\/assistant\/console/.test(v1) && /answerConsole\(/.test(v1),
    'api/v1.mjs does not route /assistant/console to answerConsole',
  );

  // 2-4. The server's rules, with a fake network and a fake mirror.
  const { answerConsole } = await import(pathToFileURL(server).href);
  const KEY = `sk-ant-api03-${'Zx9Yw8Vu'.repeat(6)}`;
  const env = { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' };
  const MIRROR = {
    '/supervisor': { data: { paused: false, flows: [{ key: FLOW, name: 'Neighborhood activation', dial: 'draft', enabled: true }] } },
    [`/flows/${FLOW}/review/summary`]: { data: { state: 'ready', best: { source: 'park-cleanup-hunt-marker' } } },
  };
  const read = async (path) => MIRROR[path] ?? null;
  const tool = (input) => ({ type: 'tool_use', id: `tu_${Math.random().toString(16).slice(2)}`, name: 'propose_change', input });
  const MODEL = {
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'The park hunt is working, so I would send more a day.' },
      tool({ summary: 'Raise leads a day to 8', method: 'POST', path: `/supervisor/flows/${FLOW}/intensity`, body: { per_day: 8, min: 1, max: 25 } }),
      tool({ summary: 'Put it on Autopilot', method: 'POST', path: `/supervisor/flows/${FLOW}/dial`, body: { stop: 'autopilot' } }),
      tool({ summary: 'Release the kill switch', method: 'POST', path: '/kill/release', body: {} }),
      tool({ summary: 'Turn on local saturation', method: 'POST', path: '/supervisor/flows/local-saturation/enable', body: {} }),
    ],
  };
  let calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(MODEL), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const page = { path: `/flows/${FLOW}`, name: 'Flow', heading: 'Neighborhood activation', text: 'Leads a day: 5' };
  const ask = (question, opts = {}) =>
    answerConsole({ question, page, flow: FLOW, history: [] }, { env, fetchImpl: fakeFetch, role: 'owner', flows: null, read, ...opts });

  const refused = await ask(`here is my key ${KEY}`);
  check(refused.status === 400 && calls.length === 0, `a key-shaped question was not refused before any call (${refused.status}, ${calls.length} calls)`);
  check(!JSON.stringify(refused.body).includes(KEY), 'the refusal repeats the key');

  const none = await ask('What is working?', { env: {} });
  check(none.status === 503 && none.body?.error?.code === 'not_configured', `without a site key expected 503 not_configured, got ${none.status}`);
  check(calls.length === 0, 'it called out without a key');

  const owner = await ask('What is working?');
  check(owner.status === 200, `expected 200, got ${owner.status} ${JSON.stringify(owner.body).slice(0, 300)}`);
  check(calls.length === 1, `expected one call, saw ${calls.length}`);
  const sent = calls[0];
  check(String(sent.url).startsWith('https://api.anthropic.com/'), 'the question did not go to the Anthropic API');
  check(sent.init.headers['x-api-key'] === env.FW_ASSISTANT_ANTHROPIC_KEY, 'the site key is not sent as the x-api-key header');
  const reqBody = String(sent.init.body);
  check(!reqBody.includes(env.FW_ASSISTANT_ANTHROPIC_KEY), 'the site key is in the request body');
  check(reqBody.includes(`/flows/${FLOW}`) && reqBody.includes('Leads a day: 5'), 'the model was not told which page this is');
  check(reqBody.includes('park-cleanup-hunt-marker'), "the model was not given the flow's review summary (what is working)");
  check(/propose_change/.test(reqBody), 'the model was not offered the propose_change tool');

  const d = owner.body?.data ?? {};
  check(/park hunt/.test(String(d.answer)), `expected the model's answer, got ${JSON.stringify(d.answer)}`);
  check(d.can_change === true, 'an owner should be able to change things');
  const paths = (d.proposals ?? []).map((p) => p.path);
  check(paths.includes(`/supervisor/flows/${FLOW}/intensity`), `the leads a day proposal was dropped: ${JSON.stringify(paths)}`);
  const kept = d.proposals.find((p) => p.path.endsWith('/intensity'));
  check(kept.kind === 'flow.intensity' && kept.method === 'POST' && kept.body?.per_day === 8, `the kept proposal is wrong: ${JSON.stringify(kept)}`);
  check(!paths.some((p) => p.endsWith('/dial')), 'an Autopilot proposal was kept');
  check(!paths.includes('/kill/release'), 'a kill switch proposal was kept');

  const viewer = await ask('What is working?', { role: 'viewer' });
  check(viewer.status === 200 && viewer.body?.data?.can_change === false, 'a viewer should get can_change false');
  check((viewer.body?.data?.proposals ?? []).length === 0, 'a viewer was given proposals');

  const helper = await ask('What is working?', { role: 'helper', flows: ['local-saturation'] });
  const hp = (helper.body?.data?.proposals ?? []).map((p) => p.path);
  check(!hp.some((p) => p.includes(FLOW)), `a helper was given a proposal for a flow outside theirs: ${JSON.stringify(hp)}`);
  check(hp.includes('/supervisor/flows/local-saturation/enable'), `a helper lost a proposal for their own flow: ${JSON.stringify(hp)}`);

  // 5. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('ai-console'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/ai-console.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the AI console checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+8 passed/.test(out), `expected 8 AI console checks to pass:\n${out.slice(-400)}`);
});
