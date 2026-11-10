// fwdRequest waits as long as fwd takes when no timeout is asked for. Node's global HTTP agent
// times sockets out after 5 s of quiet; a close that runs a row probe through fwd is quiet that long.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { fwdRequest } from '../src/fwd-client.ts';

describe('fwdRequest', () => {
  test('a slow answer (over 5 s) arrives instead of being reported as unreachable', async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end('{"data":{"done":true}}');
        }, 6_000),
      );
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const { port } = server.address() as AddressInfo;
      const r = await fwdRequest(
        { port, token: 'test' } as Parameters<typeof fwdRequest>[0],
        'POST',
        '/v1/x',
        {},
      );
      expect(r).toEqual({ status: 200, body: { data: { done: true } } });
    } finally {
      server.close();
    }
  }, 15_000);
});
