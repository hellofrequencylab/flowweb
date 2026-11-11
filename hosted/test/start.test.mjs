import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeFromPrompt, nodeOf, STEPS, START_TOOL } from '../server/start.mjs';

const ENV = { FW_ASSISTANT_ANTHROPIC_KEY: 'test-key-not-real' };
const answer = (input, status = 200) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const body =
      status === 200
        ? { content: [{ type: 'tool_use', id: 't1', name: 'propose_node', input }], stop_reason: 'tool_use' }
        : { error: { type: 'overloaded_error', message: 'busy' } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
};

test('every offered flow has its steps, and the tool forces one answer', () => {
  for (const b of START_TOOL.input_schema.properties.base.enum.filter((x) => x !== 'none')) assert.ok(STEPS[b]?.length >= 4, b);
  const s = answer({ base: 'paid-ads', name: 'Spring ads', goal: 'Cheaper sign-ups', why: 'It watches one campaign.' });
  return nodeFromPrompt({ prompt: 'Watch my ads' }, { env: ENV, fetchImpl: s.fetchImpl, role: 'admin' }).then((r) => {
    assert.equal(r.status, 200);
    assert.deepEqual(s.calls[0].body.tool_choice, { type: 'tool', name: 'propose_node' });
    assert.equal(r.body.data.node.copy.path, '/supervisor/flows/paid-ads/copy');
    assert.deepEqual(r.body.data.node.copy.body, { name: 'Spring ads', note: 'Cheaper sign-ups' });
  });
});

test('a helper sees the node but cannot make it or ask for a build', () => {
  const n = nodeOf({ base: 'none', name: 'Payroll', goal: 'Run payroll', why: 'None fits.' }, { prompt: 'payroll', canMake: false });
  assert.equal(n.copy, null);
  assert.equal(n.build_request, null);
  assert.deepEqual(n.steps, []);
});

test('an empty name falls back to the prompt, and control characters and long dashes go', () => {
  const n = nodeOf({ base: 'neighborhood-activation', name: '', goal: 'a\u0000b — c', why: '' }, { prompt: 'Find hosts', canMake: true });
  assert.equal(n.name, 'Find hosts');
  assert.equal(n.goal, 'a b, c');
});

test('an API failure answers 500 with a reason, and a missing tool call answers no_answer', async () => {
  const busy = answer(null, 529);
  const r = await nodeFromPrompt({ prompt: 'Find hosts' }, { env: ENV, fetchImpl: busy.fetchImpl, role: 'owner' });
  assert.equal(r.status, 500);
  const empty = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 });
  const e = await nodeFromPrompt({ prompt: 'Find hosts' }, { env: ENV, fetchImpl: empty, role: 'owner' });
  assert.equal(e.body.error.code, 'no_answer');
});
