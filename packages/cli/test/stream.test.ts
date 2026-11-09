// WS-P1-003: fw stream add / fw stream list against a fake CoreClient.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { CoreClient, StreamView } from '../src/client.ts';
import { EXIT, main } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'fw-cli-stream-'));
writeFileSync(join(dir, 'def.json'), '{"id":"stm_x0001"}');
writeFileSync(join(dir, 'bad.json'), 'not json');

const view: StreamView = {
  id: 'stm_x0001',
  project_id: 'prj_x',
  key: 'x',
  name: 'X',
  template: 'custom',
  status: 'active',
  default_tier: 'L2',
  version: 1,
  wip_limit: 2,
  trigger: 'manual',
  budget: { caps: { max_usd: 1 }, period: 'day' },
  definition_hash: 'f'.repeat(64),
  last_fired_at: null,
  created_at: '2026-11-09T00:00:00Z',
};

async function run(argv: string[], client: Partial<CoreClient>) {
  const o: string[] = [];
  const e: string[] = [];
  const io = {
    out: (t: string) => void o.push(t),
    err: (t: string) => void e.push(t),
    env: {},
    cwd: dir,
  };
  const code = await main(argv, io, () => ({ close() {}, ...client }) as CoreClient);
  return { code, out: o.join('\n'), err: e.join('\n') };
}

test('fw stream add -f reads the file relative to the cwd and passes --approval', async () => {
  const calls: unknown[] = [];
  const r = await run(['stream', 'add', '-f', 'def.json', '--approval', 'apr_x1', '--json'], {
    streamAdd: async (d, o) => {
      calls.push([d, o]);
      return { stream: view, approval_id: 'apr_x1', event_seq: 7 };
    },
  });
  expect(r.code).toBe(EXIT.OK);
  expect(calls).toEqual([[{ id: 'stm_x0001' }, { approvalId: 'apr_x1' }]]);
  expect(JSON.parse(r.out).stream.id).toBe('stm_x0001');
});

test('a tier refusal exits 3 and a missing budget exits 1, each naming the reason', async () => {
  const refuse = (code: string, message: string) => ({
    streamAdd: async () => Promise.reject(Object.assign(new Error(message), { code })),
  });
  const tier = await run(
    ['stream', 'add', '-f', 'def.json'],
    refuse('APPROVAL_REQUIRED', 'needs a recorded Owner approval'),
  );
  expect(tier.code).toBe(EXIT.POLICY);
  expect(tier.err).toMatch(/approval/);
  const budget = await run(
    ['stream', 'add', '-f', 'def.json'],
    refuse('INVALID_DEFINITION', 'a stream without a budget'),
  );
  expect(budget.code).toBe(EXIT.FAILED);
  expect(budget.err).toMatch(/budget/);
});

test('fw stream add refuses a file that is not JSON, and needs -f', async () => {
  expect((await run(['stream', 'add', '-f', 'bad.json'], {})).code).toBe(EXIT.FAILED);
  expect((await run(['stream', 'add'], {})).code).toBe(EXIT.USAGE);
});

test('fw stream list prints every stream, as a table or one JSON document', async () => {
  const client = { streamList: async () => [view] };
  expect(JSON.parse((await run(['stream', 'list', '--json'], client)).out)).toEqual({ streams: [view] });
  expect((await run(['stream', 'list'], client)).out).toMatch(
    /stm_x0001\s+prj_x\s+x\s+L2\s+active\s+manual\s+max_usd=1\/day/,
  );
  expect((await run(['stream', 'list'], {})).code).toBe(EXIT.FAILED);
});
