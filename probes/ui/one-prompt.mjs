// Probe for FW-C-124 (the Owner starts from one prompt): `pnpm probe ui/one-prompt`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: hosted/server/start.mjs (nodeFromPrompt, STEPS, START_TOOL; pure apart from an injected fetch),
// hosted/server/requests.mjs (requestOf, fwdCallFor), hosted/server/console.mjs (buildRequestOf, FW-C-112),
// api/v1.mjs (source), and the /start page packages/web/src/start/OnePrompt.tsx (its checks are in
// probes/ui/one-prompt.spec.tsx, vitest in jsdom against a fetch stub, with routeOf from shell/routes.ts).
//
// The surface this probe expects (spec: https://claude.ai/artifact/SJLcQ6o8PfbFV8rTBuTfhq, "First run"):
//   nodeFromPrompt(body, { env, fetchImpl, role }) -> { status, body }. body { prompt, previous? }; a 200 body is
//     { data: { node, can_make } } with node { name, goal, why, base, dial: 'draft', steps, copy, build_request }.
//     The model answers through one tool, START_TOOL (name propose_node), whose input has base (an enum of the
//     copyable flows plus 'none'), name, goal and why. steps are STEPS[base] from code: [{ id, label, detail,
//     needs: { kind: approval | sender | cap, label } | null }]. copy is { method: 'POST', path:
//     '/supervisor/flows/{base}/copy', body: { name, note } } when a flow fits and the role can make it.
//     build_request is { title, what, done_when } when nothing fits.
//   requestOf: POST /supervisor/flows/{base}/copy { name?, note?, slug? } -> flow.copy, flow base, payload with
//     only those three; fwdCallFor maps it back.
//
// Proves, in order:
//   1. A fitting answer becomes a node with code-made steps, the owner's check and the sender as needs, and a
//      copy request the site queues as flow.copy. The prompt (and a previous node) reach the model.
//   2. A flow that cannot be copied, or none, becomes a node with a build request and no copy.
//   3. Bad prompts are refused before any call; no key answers 503; a viewer cannot make the node.
//   4. The site queue carries flow.copy both ways; the live API routes /assistant/start.
//   5. /start and its checks pass (5 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/one-prompt';
const START = 'hosted/server/start.mjs';
const NOT_COPYABLE = ['host-moments', 'local-pulse', 'email-queue'];
const DASH = /[–—]/;
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const ENV = { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' };

/** A fetch stub that answers the Messages API with one propose_node call, and records what was sent. */
function stub(input) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(
      JSON.stringify({
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_probe', name: 'propose_node', input }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { calls, fetchImpl };
}

await probe(NAME, async () => {
  if (!existsSync(join(root, START))) missing(`${START} does not exist (row FW-C-124)`);
  const { nodeFromPrompt, STEPS, START_TOOL } = await imp(START);
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const { buildRequestOf } = await imp('hosted/server/console.mjs');
  check(typeof nodeFromPrompt === 'function' && STEPS && START_TOOL, 'start.mjs is missing nodeFromPrompt, STEPS or START_TOOL');

  // ---- 1. a fitting answer -------------------------------------------------------------------------------
  const bases = START_TOOL?.input_schema?.properties?.base?.enum ?? [];
  check(START_TOOL.name === 'propose_node', `the tool is ${START_TOOL.name}`);
  for (const b of ['neighborhood-activation', 'paid-ads', 'none']) check(bases.includes(b), `the tool's base enum lacks ${b}`);
  for (const b of NOT_COPYABLE) check(!bases.includes(b), `the tool offers ${b}, which cannot be copied`);
  for (const b of bases.filter((x) => x !== 'none')) {
    const s = STEPS[b];
    check(Array.isArray(s) && s.length >= 4, `STEPS has ${s?.length ?? 0} steps for ${b}`);
    check(s.some((x) => x.needs?.kind === 'approval'), `${b} has no step where the owner checks first`);
  }
  check(STEPS['neighborhood-activation'].some((x) => x.needs?.kind === 'sender'), 'neighborhood-activation has no sender step');
  check(STEPS['paid-ads'].some((x) => x.needs?.kind === 'cap'), 'paid-ads has no spend cap step');

  const prompt = 'Find local yoga teachers in Austin and invite them to host a class on Frequency.';
  const fit = stub({
    base: 'neighborhood-activation',
    name: 'Austin yoga hosts — spring',
    goal: 'Get yoga teachers in Austin hosting their first class',
    why: 'Finding local teachers and inviting them is what this flow does.',
  });
  const a = await nodeFromPrompt({ prompt }, { env: ENV, fetchImpl: fit.fetchImpl, role: 'owner' });
  check(a.status === 200, `a fitting prompt answered ${a.status}: ${JSON.stringify(a.body).slice(0, 200)}`);
  check(fit.calls.length === 1 && /anthropic\.com\/v1\/messages$/.test(fit.calls[0].url), 'the model was not called once on the Messages API');
  const sent = fit.calls[0].body;
  check(JSON.stringify(sent.messages).includes('Austin'), 'the prompt did not reach the model');
  check((sent.tools ?? []).some((t) => t.name === 'propose_node'), 'the model was not given propose_node');
  const node = a.body?.data?.node;
  check(a.body?.data?.can_make === true, 'an owner cannot make the node');
  check(node?.base === 'neighborhood-activation' && node?.dial === 'draft', `node base ${node?.base}, dial ${node?.dial}`);
  check(node.name && !DASH.test(JSON.stringify(node)), `the node keeps a long dash: ${node.name}`);
  check(JSON.stringify(node.steps) === JSON.stringify(STEPS['neighborhood-activation']), 'the steps are not the code-made ones');
  check(node.copy?.method === 'POST' && node.copy?.path === '/supervisor/flows/neighborhood-activation/copy', `copy is ${JSON.stringify(node.copy)}`);
  check(Object.keys(node.copy.body).every((k) => ['name', 'note'].includes(k)) && node.copy.body.name === node.name, `copy body ${JSON.stringify(node.copy.body)}`);
  const q = requestOf(node.copy.method, node.copy.path, node.copy.body);
  check(q && !q.error && q.kind === 'flow.copy' && q.flow === 'neighborhood-activation', `the site would queue ${JSON.stringify(q)}`);
  check(node.build_request === null, 'a fitting node carries a build request');

  const grow = stub({ base: 'neighborhood-activation', name: 'Austin yoga hosts', goal: 'Also follow up after five days', why: 'Same flow.' });
  const g = await nodeFromPrompt(
    { prompt: 'Also follow up after five days', previous: { name: node.name, goal: node.goal, base: node.base } },
    { env: ENV, fetchImpl: grow.fetchImpl, role: 'owner' },
  );
  check(g.status === 200, `adding to a node answered ${g.status}`);
  check(JSON.stringify(grow.calls[0]?.body?.messages).includes(node.goal), 'the previous node did not reach the model');

  // ---- 2. nothing fits -------------------------------------------------------------------------------------
  for (const base of ['host-moments', 'none']) {
    const s = stub({ base, name: 'Payroll', goal: 'Run payroll every other Friday', why: 'No payroll flow exists yet.' });
    const r = await nodeFromPrompt({ prompt: 'Run payroll for my two staff' }, { env: ENV, fetchImpl: s.fetchImpl, role: 'owner' });
    check(r.status === 200, `an unsupported prompt answered ${r.status}`);
    const n = r.body?.data?.node;
    check(n?.base === null && n?.copy === null, `with base ${base} the node is ${JSON.stringify(n).slice(0, 200)}`);
    check(n.build_request && buildRequestOf(n.build_request), `with base ${base} the build request is ${JSON.stringify(n?.build_request)}`);
  }

  // ---- 3. refusals and roles -------------------------------------------------------------------------------
  const quiet = stub({ base: 'none', name: 'x', goal: 'x', why: 'x' });
  for (const [body, want] of [
    [{ prompt: '' }, 400],
    [{ prompt: 'x'.repeat(2001) }, 400],
    [{ prompt: 'use this one: Zq7Xw2Lm9Pk4Rt6Yv1Bn8Cd3Fg5Hj0Ks2Qw4Er6Ty8Ua please' }, 400],
  ]) {
    const r = await nodeFromPrompt(body, { env: ENV, fetchImpl: quiet.fetchImpl, role: 'owner' });
    check(r.status === want, `${JSON.stringify(body).slice(0, 40)} answered ${r.status}, want ${want}`);
  }
  check(quiet.calls.length === 0, 'a refused prompt still reached the model');
  const nokey = await nodeFromPrompt({ prompt }, { env: {}, fetchImpl: quiet.fetchImpl, role: 'owner' });
  check(nokey.status === 503 && quiet.calls.length === 0, `no key answered ${nokey.status}`);
  const v = stub({ base: 'neighborhood-activation', name: 'A', goal: 'B', why: 'C' });
  const vr = await nodeFromPrompt({ prompt }, { env: ENV, fetchImpl: v.fetchImpl, role: 'viewer' });
  check(vr.status === 200 && vr.body?.data?.can_make === false && vr.body?.data?.node?.copy === null, `a viewer got ${JSON.stringify(vr.body?.data).slice(0, 200)}`);

  // ---- 4. the site queue and the live API --------------------------------------------------------------------
  const P = '/supervisor/flows/paid-ads/copy';
  const r = requestOf('POST', P, { name: 'Austin ads', note: 'Sign-ups in Austin', slug: 'austin', config: { x: 1 } });
  check(r && !r.error && r.kind === 'flow.copy' && r.flow === 'paid-ads', `POST ${P} became ${JSON.stringify(r)}`);
  check(JSON.stringify(r.payload) === JSON.stringify({ name: 'Austin ads', note: 'Sign-ups in Austin', slug: 'austin' }), `flow.copy carries ${JSON.stringify(r.payload)}`);
  const call = fwdCallFor({ id: 'r1', ...r });
  check(call?.method === 'POST' && call.path === P && JSON.stringify(call.body) === JSON.stringify(r.payload), `the relay calls ${JSON.stringify(call)}`);
  check(requestOf('POST', '/supervisor/flows/Bad Flow/copy', {})?.error, 'a bad flow key was queued');
  check(requestOf('POST', P, { name: 7 })?.error, 'a bad name was queued');
  check(requestOf('POST', P, {})?.kind === 'flow.copy', 'a copy with no fields was refused');
  const api = readFileSync(join(root, 'api/v1.mjs'), 'utf8');
  check(/['"`]\/assistant\/start['"`]/.test(api) && /nodeFromPrompt/.test(api), 'api/v1.mjs does not route /assistant/start');

  // ---- 5. the /start page --------------------------------------------------------------------------------------
  if (!existsSync(join(root, 'packages/web/src/start/OnePrompt.tsx'))) missing('packages/web/src/start/OnePrompt.tsx does not exist');
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('one-prompt'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/one-prompt.spec.tsx')], testTimeout: 30000 },
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
  check(out.status === 0, `the /start checks failed (exit ${out.status}):\n${failed.join('\n') || text.slice(-800)}`);
  check(/Tests\s+5 passed/.test(text), `expected 5 /start checks to pass:\n${text.slice(-400)}`);
});
