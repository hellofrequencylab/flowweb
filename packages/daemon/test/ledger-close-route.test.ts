// WS-P0-021: `fw ledger close` while fwd holds the writer goes to POST /v1/ledger/rows/{id}/close,
// which runs the same close on fwd's writer. The route checks its input and surfaces the kernel's
// refusals; the close itself is covered in packages/ledger/test/lifecycle.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.ts';
import { call, seed, tempHome } from './api-fixtures.ts';

describe('ledger close route on fwd', () => {
  const home = tempHome();
  let d: Daemon;
  beforeAll(async () => {
    seed(home.path);
    d = await startDaemon({ fwHome: home.path, port: 0, devNoAuth: true, log: () => {} });
  });
  afterAll(async () => {
    await d?.stop('test done');
    home.cleanup();
  });
  const post = (path: string, body: unknown) => call(d.port, 'POST', `/v1${path}`, { body });

  test('needs a merged sha and an absolute repo dir', async () => {
    expect((await post('/ledger/rows/FW-C-020/close', {})).status).toBe(400);
    expect(
      (await post('/ledger/rows/FW-C-020/close', { merged_sha: 'a'.repeat(40), repo_dir: 'rel' })).status,
    ).toBe(400);
  });

  test("surfaces the kernel's refusal and changes nothing", async () => {
    const r = await post('/ledger/rows/FW-C-020/close', { merged_sha: 'a'.repeat(40), repo_dir: home.path });
    expect(r.status).not.toBe(200);
    expect(JSON.stringify(r.json)).toContain('illegal ledger_row transition: FW-C-020 blocked -> done');
    const row = await call(d.port, 'GET', '/v1/ledger/rows/lr_FWC020');
    expect(row.json.data.status).toBe('blocked');
  });
});
