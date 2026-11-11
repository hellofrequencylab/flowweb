import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiDetail, refusalReason } from '../server/site-key.mjs';

test('a 400 names the API reason, with anything key-shaped removed', () => {
  const why = refusalReason(400, 'invalid_request_error', 'fallback', 'bad field for sk-ant-api03-abcDEF_123');
  assert.match(why, /^Anthropic turned the request down: bad field for \[key\]$/);
  assert.doesNotMatch(why, /sk-ant/);
});

test('a 400 with no message keeps the fallback, and a long message is cut', () => {
  assert.equal(refusalReason(400, 'invalid_request_error', 'fallback', ''), 'fallback');
  assert.equal(apiDetail('x'.repeat(500)).length, 240);
});

test('a person-linked key names a workspace; a workspace key does not', async () => {
  const { workspaceHeaders } = await import('../server/site-key.mjs');
  assert.deepEqual(workspaceHeaders({}, 'sk-ant-usr-abc'), { 'anthropic-workspace-id': 'default' });
  assert.deepEqual(workspaceHeaders({ FW_ASSISTANT_ANTHROPIC_WORKSPACE: ' wrkspc_1 ' }, 'sk-ant-usr-abc'), {
    'anthropic-workspace-id': 'wrkspc_1',
  });
  assert.deepEqual(workspaceHeaders({}, 'sk-ant-api03-abc'), {});
});
