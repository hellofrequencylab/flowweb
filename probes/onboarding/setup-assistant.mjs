// Probe for FW-C-085 (a setup assistant that helps a new person connect their own AI account):
// `pnpm probe onboarding/setup-assistant`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/setup/SetupAssistant.tsx, rendered by the Get started page (SetupPage), and
// hosted/server/assistant.mjs, which api/v1.mjs serves as POST /v1/assistant/setup on the live site.
//
// The page's surface, checked in probes/onboarding/setup-assistant.spec.tsx (vitest, jsdom, a fetch stub
// standing in for the live site): a status region named "What to do next" that reads what the machine last
// reported and says the one next thing (put FlowWeb on a machine; pick an AI account and run its
// `pnpm fw accounts connect` command; fix a failed account test; the next setup step), a box named
// "Ask the setup assistant" whose questions go to /v1/assistant/setup and fall back to built-in answers,
// and a log named "Setup conversation". Anything that looks like a key is refused unshown, unstored, unsent.
//
// Proves, in order:
//   1. SetupPage renders <SetupAssistant, and api/v1.mjs routes /assistant/setup to answerSetupQuestion.
//   2. The server refuses a key-shaped question without any network call, answers 503 not_configured
//      without FW_ASSISTANT_ANTHROPIC_KEY, sends the key only as a header (never in the body), and returns
//      the model's text.
//   3. The component checks pass (7 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'onboarding/setup-assistant';

await probe(NAME, async () => {
  // 1. Wiring.
  const comp = join(root, 'packages/web/src/setup/SetupAssistant.tsx');
  if (!existsSync(comp)) missing('packages/web/src/setup/SetupAssistant.tsx does not exist (row FW-C-085)');
  const page = readFileSync(join(root, 'packages/web/src/setup/SetupPage.tsx'), 'utf8');
  check(/<SetupAssistant\b/.test(page), 'SetupPage does not render <SetupAssistant>');
  const server = join(root, 'hosted/server/assistant.mjs');
  if (!existsSync(server)) missing('hosted/server/assistant.mjs does not exist (row FW-C-085)');
  const v1 = readFileSync(join(root, 'api/v1.mjs'), 'utf8');
  check(
    /\/assistant\/setup/.test(v1) && /answerSetupQuestion\(/.test(v1),
    'api/v1.mjs does not route /assistant/setup to answerSetupQuestion',
  );

  // 2. The server's rules, with a fake network.
  const { answerSetupQuestion } = await import(pathToFileURL(server).href);
  const KEY = `sk-ant-api03-${'Zx9Yw8Vu'.repeat(6)}`;
  let calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Use the plan you have.' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const env = { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' };

  const refused = await answerSetupQuestion({ question: `my key is ${KEY}` }, { env, fetchImpl: fakeFetch });
  check(refused.status === 400 && calls.length === 0, `a key-shaped question was not refused before any call (${refused.status}, ${calls.length} calls)`);
  check(!JSON.stringify(refused.body).includes(KEY), 'the refusal repeats the key');

  const none = await answerSetupQuestion({ question: 'Which AI should I use?' }, { env: {}, fetchImpl: fakeFetch });
  check(none.status === 503 && none.body?.error?.code === 'not_configured', `without a site key expected 503 not_configured, got ${none.status}`);
  check(calls.length === 0, 'it called out without a key');

  const ok = await answerSetupQuestion({ question: 'Which AI should I use?', stage: 'ai' }, { env, fetchImpl: fakeFetch });
  check(ok.status === 200 && ok.body?.data?.answer === 'Use the plan you have.', `expected the model's answer, got ${ok.status} ${JSON.stringify(ok.body)}`);
  check(calls.length === 1, `expected one call, saw ${calls.length}`);
  const sent = calls[0];
  check(String(sent.url).startsWith('https://api.anthropic.com/'), 'the question did not go to the Anthropic API');
  check(sent.init.headers['x-api-key'] === env.FW_ASSISTANT_ANTHROPIC_KEY, 'the site key is not sent as the x-api-key header');
  check(!String(sent.init.body).includes(env.FW_ASSISTANT_ANTHROPIC_KEY), 'the site key is in the request body');

  // 3. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('setup-assistant'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/onboarding/setup-assistant.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the setup assistant checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 setup assistant checks to pass:\n${out.slice(-400)}`);
});
