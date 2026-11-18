// Probe for FW-C-164 (Kevin can change who a flow looks for and how its notes read, for the main flow and
// every copy, and the person still confirms): `pnpm probe ui/kevin-targeting`.
// probe-timeout-s: 60
// Tier 0.
// Surface: hosted/server/console.mjs, which api/v1.mjs serves as POST /v1/assistant/console (FW-C-092).
// Pure: a fake network stands in for the AI and a fake mirror for what the relay copied from the Mac.
//
// The surface this probe expects:
//   with a flow in view, the model is given that flow's mirrored /flows/<key>/targeting (FW-C-156), so it
//     can quote the line it would change; with no flow in view, the targeting of each flow the Supervisor lists;
//   the model is told the targeting control exists (POST /flows/FLOW/targeting);
//   a proposal to POST /flows/<key>/targeting with playbook lines is kept as a flow.edit for that flow, for the
//     main flow and for a copy; one that names a line the control does not have is dropped; a viewer gets none;
//     a helper limited to other flows gets none; nothing outside the control (a cap, a budget) rides along.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'ui/kevin-targeting';
const BASE = 'neighborhood-activation';
const COPY = `${BASE}--coaches-guides`;

await probe(NAME, async () => {
  const server = join(root, 'hosted/server/console.mjs');
  if (!existsSync(server)) missing('hosted/server/console.mjs does not exist (row FW-C-092)');
  const { answerConsole } = await import(pathToFileURL(server).href);

  const env = { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' };
  const MIRROR = {
    '/supervisor': { data: { paused: false, flows: [{ key: BASE, name: 'Saturation' }, { key: COPY, name: 'Coaches and Guides' }] } },
    [`/flows/${BASE}/targeting`]: { data: { key: BASE, playbook: { seek: 'base-seek-marker' }, niches: [] } },
    [`/flows/${COPY}/targeting`]: { data: { key: COPY, playbook: { seek: 'copy-seek-marker', skip: 'copy-skip-marker' }, niches: [] } },
  };
  const read = async (path) => MIRROR[path] ?? null;
  const tool = (path, body) => ({
    type: 'tool_use',
    id: `tu_${Math.random().toString(16).slice(2)}`,
    name: 'propose_change',
    input: { summary: `Change ${path}`, method: 'POST', path, body },
  });
  const MODEL = {
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I would tighten who it skips.' },
      tool(`/flows/${COPY}/targeting`, { playbook: { skip: 'National chains and franchises.' } }),
      tool(`/flows/${BASE}/targeting`, { playbook: { seek: 'Hosts of small local events.', note: 'Warm and short.' } }),
      tool(`/flows/${COPY}/targeting`, { playbook: { budget: 'Spend more.' } }),
    ],
  };
  let calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(MODEL), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ask = (flow, opts = {}) =>
    answerConsole(
      { question: 'Stop it writing to chains.', page: { path: flow ? `/flows/${flow}` : '/', name: 'Flow', text: '' }, ...(flow ? { flow } : {}), history: [] },
      { env, fetchImpl: fakeFetch, role: 'owner', flows: null, read, ...opts },
    );

  // 1. What the model is shown.
  const inView = await ask(COPY);
  check(inView.status === 200, `expected 200, got ${inView.status} ${JSON.stringify(inView.body).slice(0, 300)}`);
  const seen = String(calls[0]?.init?.body ?? '');
  check(seen.includes('copy-skip-marker'), "the model was not given the targeting of the flow in view, so it cannot quote the line it would change");
  check(/POST \/flows\/FLOW\/targeting/.test(seen), 'the model was not told it may propose a targeting change');
  calls = [];
  await ask(null);
  const all = String(calls[0]?.init?.body ?? '');
  check(all.includes('base-seek-marker') && all.includes('copy-seek-marker'), 'with no flow in view the model was not given each flow\'s targeting');

  // 2. What a person may confirm.
  const props = inView.body?.data?.proposals ?? [];
  const forCopy = props.find((p) => p.path === `/flows/${COPY}/targeting`);
  const forBase = props.find((p) => p.path === `/flows/${BASE}/targeting`);
  check(forCopy && forCopy.kind === 'flow.edit' && forCopy.flow === COPY, `the copy's targeting proposal was not kept as a flow.edit: ${JSON.stringify(props)}`);
  check(forCopy?.body?.playbook?.skip === 'National chains and franchises.', 'the kept proposal lost its line');
  check(forBase && forBase.kind === 'flow.edit' && forBase.flow === BASE, "the main flow's targeting proposal was not kept");
  check(props.length === 2, `a proposal naming a line the control does not have was kept: ${JSON.stringify(props.map((p) => p.body))}`);

  const viewer = await ask(COPY, { role: 'viewer' });
  check((viewer.body?.data?.proposals ?? []).length === 0, 'a viewer was given a targeting proposal');
  const helper = await ask(COPY, { role: 'helper', flows: ['local-saturation'] });
  check((helper.body?.data?.proposals ?? []).length === 0, 'a helper limited to another flow was given a targeting proposal');
});
