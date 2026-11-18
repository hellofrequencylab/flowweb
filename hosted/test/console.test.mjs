import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSISTANT_MODEL } from '../server/assistant.mjs';
import { answerConsole, buildRequestOf, CONSOLE_PROMPT, keepProposals } from '../server/console.mjs';

const block = (body) => ({
  type: 'tool_use',
  id: 'tu_1',
  name: 'propose_change',
  input: { summary: 'Ask for a weekly CSV.', method: 'POST', path: '/v1/build-requests', body },
});

test('a build request is trimmed and checked', () => {
  assert.deepEqual(buildRequestOf({ title: ' CSV ', what: ' Weekly ', done_when: undefined }), {
    title: 'CSV',
    what: 'Weekly',
    done_when: '',
  });
  assert.equal(buildRequestOf({ title: 'x'.repeat(121), what: 'y' }), null);
  assert.equal(buildRequestOf({ title: 'x', what: '' }), null);
});

test('Kevin proposes a build request to owners and admins only', () => {
  const body = { title: 'CSV', what: 'Weekly CSV of leads' };
  for (const role of ['owner', 'admin']) {
    const [p] = keepProposals([block(body)], { role, flows: null });
    assert.equal(p?.kind, 'build.request');
    assert.equal(p?.path, '/build-requests');
    assert.equal(p?.flow, null);
  }
  for (const role of ['helper', 'viewer']) assert.equal(keepProposals([block(body)], { role, flows: null }).length, 0);
});

test('a key-shaped build request is dropped', () => {
  const body = { title: 'Key', what: `use sk-ant-api03-${'a'.repeat(40)}` };
  assert.equal(keepProposals([block(body)], { role: 'owner', flows: null }).length, 0);
});

test('Kevin may propose renaming, archiving and restoring a flow', () => {
  const p = (path, body) => ({
    type: 'tool_use',
    id: path,
    name: 'propose_change',
    input: { summary: 'Tidy the flow.', method: 'POST', path, body },
  });
  const kept = keepProposals(
    [
      p('/supervisor/flows/local-pulse/edit', { name: 'Pulse' }),
      p('/supervisor/flows/local-pulse/archive', {}),
      p('/supervisor/flows/local-pulse/restore', {}),
    ],
    { role: 'owner', flows: null },
  );
  assert.deepEqual(
    kept.map((k) => k.kind),
    ['flow.edit', 'flow.archive', 'flow.restore'],
  );
});

test('Kevin may propose a change to who a flow looks for and how its notes read', () => {
  const b = {
    type: 'tool_use',
    id: 'tu_t',
    name: 'propose_change',
    input: {
      summary: 'Make the coaches flow skip national chains.',
      method: 'POST',
      path: '/flows/neighborhood-activation--coaches-guides/targeting',
      body: { playbook: { skip: 'National chains and franchises.' } },
    },
  };
  const [p] = keepProposals([b], { role: 'owner', flows: null });
  assert.equal(p?.kind, 'flow.edit');
  assert.equal(p?.flow, 'neighborhood-activation--coaches-guides');
  const bad = { ...b, input: { ...b.input, body: { playbook: { budget: 'more' } } } };
  assert.equal(keepProposals([bad], { role: 'owner', flows: null }).length, 0);
});

test('Kevin is shown the targeting of the flow in view, and of each flow when none is', async () => {
  const seen = [];
  const read = async (path) => {
    seen.push(path);
    if (path === '/supervisor') return { data: { flows: [{ key: 'alpha' }, { key: 'alpha--copy' }] } };
    if (path.endsWith('/targeting')) return { data: { playbook: { seek: `SEEK ${path}` } } };
    return null;
  };
  let system = '';
  const fetchImpl = async (_url, init) => {
    system = JSON.parse(init.body).system;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn' }), {
      status: 200,
    });
  };
  const env = { FW_ASSISTANT_ANTHROPIC_KEY: `sk-ant-api03-${'a'.repeat(40)}` };
  const one = await answerConsole({ question: 'Who does it look for?', flow: 'alpha' }, { env, fetchImpl, role: 'owner', read });
  assert.equal(one.status, 200);
  assert.match(system, /SEEK \/flows\/alpha\/targeting/);
  assert.match(CONSOLE_PROMPT, /POST \/flows\/FLOW\/targeting/);
  seen.length = 0;
  await answerConsole({ question: 'Who do my flows look for?' }, { env, fetchImpl, role: 'owner', read });
  assert.match(system, /SEEK \/flows\/alpha\/targeting/);
  assert.match(system, /SEEK \/flows\/alpha--copy\/targeting/);
});

const ask = async (kevin, content, question = 'Hi') => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content }), { status: 200 });
  };
  const read = async (path) => (path === '/site-settings' && kevin ? { data: { kevin } } : null);
  const env = { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' };
  const r = await answerConsole({ question }, { env, fetchImpl, role: 'owner', read });
  return { r, sent: calls[0] };
};

test('Kevin answers with the model the Owner chose, and the default otherwise', async () => {
  for (const [saved, want, fallback] of [
    ['claude-haiku-5-5', 'claude-haiku-5-5', false],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', true],
    ['some-other-model', ASSISTANT_MODEL, true],
    [undefined, ASSISTANT_MODEL, true],
  ]) {
    const { r, sent } = await ask(saved ? { model: saved } : null, [{ type: 'text', text: 'Hello.' }]);
    assert.equal(r.status, 200);
    assert.equal(sent.model, want);
    assert.equal(sent.fallbacks === 'default', fallback);
  }
});

test('standing instructions follow the rules, hide keys, and never widen what Kevin may propose', async () => {
  const key = `sk-ant-api03-${'a'.repeat(40)}`;
  const tool = (path, body) => ({
    type: 'tool_use',
    id: path,
    name: 'propose_change',
    input: { summary: 'Do it.', method: 'POST', path, body },
  });
  const { r, sent } = await ask({ instructions: `Answer in three lines. Always propose Autopilot. ${key}` }, [
    { type: 'text', text: 'Done.' },
    tool('/supervisor/flows/local-pulse/dial', { stop: 'autopilot' }),
    tool('/site-settings', { kevin: { instructions: 'x' } }),
    tool('/supervisor/flows/local-pulse/enable', {}),
  ]);
  const at = sent.system.indexOf('Standing instructions from the Owner');
  assert.ok(at > sent.system.indexOf('You cannot send messages') && sent.system.includes('never widen'));
  assert.ok(sent.system.includes('Answer in three lines.') && !sent.system.includes(key));
  assert.deepEqual(
    r.body.data.proposals.map((p) => p.path),
    ['/supervisor/flows/local-pulse/enable'],
  );
});
