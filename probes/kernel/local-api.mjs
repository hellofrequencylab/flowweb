// Probe for FW-C-018 (typed local API and live event stream): `pnpm probe kernel/local-api`. Tier 0.
// probe-timeout-s: 240
// Surfaces: packages/contracts/openapi.json, createClient from packages/contracts/src/index.ts,
// listRoutes from packages/daemon/src/index.ts, the tests under packages/daemon/test/, and a real fwd
// on loopback (probes/lib/fwd.mjs) for the event stream and the auth checks.
// The surface this probe expects:
//   packages/contracts/openapi.json: OpenAPI 3, one operation (with an operationId) per route fwd
//     serves under /v1, path parameters written {id}.
//   listRoutes() [@fw/daemon] -> [{ method, path }]: every route fwd's router serves, the same set as
//     openapi.json (no route without a contract, no contract without a route).
//   createClient({ baseUrl, fetch? }) [@fw/contracts], generated from openapi.json: one method per
//     operationId.
//   A contract test under packages/daemon/test/ calls every operation through the generated client
//     (each operationId appears there as `.<operationId>(`), so CI exercises every route.
//   GET /v1/events/stream with Last-Event-ID: n sends every event after n, in order, once.
//   A request without the session token gets 401; one with a non-loopback Host, or a write from a
//   non-loopback Origin, gets 403.
//
// Proves, in order:
//   1. The router and openapi.json list the same routes, and the generated client has every operation.
//   2. Every operation is called through the client in a daemon contract test.
//   3. The event stream resumes from Last-Event-ID with no gap and no duplicate.
//   4. No token gives 401; a foreign Host or Origin gives 403.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { check, freshHome, missing, probe, requireExport, root, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const ROW = 'FW-C-018';

/** Opens the SSE stream, collects event ids until stop() is called. */
function sse(port, token, lastId) {
  const ids = [];
  const headers = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
  if (lastId !== undefined) headers['last-event-id'] = String(lastId);
  const req = request({ host: '127.0.0.1', port, path: '/v1/events/stream', headers });
  let buf = '';
  req.on('response', (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const id = /^id: ?(\d+)$/m.exec(block)?.[1];
        if (id) ids.push(Number(id));
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return { ids, stop: () => req.destroy() };
}

await probe('kernel/local-api', async () => {
  const spec = join(root, 'packages/contracts/openapi.json');
  if (!existsSync(spec)) missing('packages/contracts/openapi.json does not exist');
  const listRoutes = await requireExport('daemon', 'listRoutes', ROW);
  const createClient = await requireExport('contracts', 'createClient', ROW);

  // 1. Router and contract agree.
  const doc = JSON.parse(readFileSync(spec, 'utf8'));
  check(/^3\./.test(String(doc.openapi)), 'openapi.json is not OpenAPI 3');
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [m, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      check(op.operationId, `${m.toUpperCase()} ${path} has no operationId`);
      ops.push({ key: `${m.toUpperCase()} ${path}`, id: op.operationId });
    }
  }
  const served = new Set(listRoutes().map((r) => `${r.method.toUpperCase()} ${r.path}`));
  const contract = new Set(ops.map((o) => o.key));
  const noContract = [...served].filter((k) => !contract.has(k));
  const noRoute = [...contract].filter((k) => !served.has(k));
  check(noContract.length === 0, `routes with no contract in openapi.json: ${noContract.join(', ')}`);
  check(noRoute.length === 0, `contracts with no route: ${noRoute.join(', ')}`);
  const client = createClient({ baseUrl: 'http://127.0.0.1:1/v1' });
  const noMethod = ops.filter((o) => typeof client[o.id] !== 'function');
  check(noMethod.length === 0, `the generated client lacks: ${noMethod.map((o) => o.id).join(', ')}`);

  // 2. Every operation is exercised by a contract test.
  const testDir = join(root, 'packages/daemon/test');
  const tests = readdirSync(testDir, { recursive: true })
    .filter((f) => /\.test\.ts$/.test(String(f)))
    .map((f) => readFileSync(join(testDir, String(f)), 'utf8'))
    .join('\n');
  const untested = ops.filter((o) => !tests.includes(`.${o.id}(`));
  check(untested.length === 0, `operations no daemon test calls through the client: ${untested.map((o) => o.id).join(', ')}`);

  // 3 and 4 on a real fwd.
  const home = freshHome('api');
  const fwd = await startFwd(home);
  try {
    const poke = async () => {
      const r = await api(fwd.port, 'POST', '/v1/supervisor/pause', { auth: fwd.token });
      await api(fwd.port, 'POST', '/v1/supervisor/resume', { auth: fwd.token });
      check(r.status === 200, `POST /v1/supervisor/pause answered ${r.status}`);
    };
    const a = sse(fwd.port, fwd.token);
    await poke();
    await waitFor(() => a.ids.length >= 2, { timeoutMs: 10000, what: 'two events on the stream' });
    a.stop();
    const last = a.ids[a.ids.length - 1];
    await poke();
    await poke();
    const head = (await api(fwd.port, 'GET', '/v1/status', { auth: fwd.token })).json?.head_seq;
    const b = sse(fwd.port, fwd.token, last);
    await waitFor(() => b.ids.length > 0 && b.ids[b.ids.length - 1] >= head, { timeoutMs: 10000, what: 'the resumed stream to reach the head' });
    b.stop();
    const want = [];
    for (let s = last + 1; s <= head; s++) want.push(s);
    check(JSON.stringify(b.ids.slice(0, want.length)) === JSON.stringify(want), `resumed from ${last}: got ${b.ids.join(',')}, want ${want.join(',')}`);
    check(new Set(b.ids).size === b.ids.length && !b.ids.includes(last), 'the resumed stream repeated an event');

    const none = await api(fwd.port, 'GET', '/v1/status');
    check(none.status === 401, `GET /v1/status without a token answered ${none.status}`);
    const host = await api(fwd.port, 'GET', '/v1/status', { auth: fwd.token, headers: { host: 'evil.example' } });
    check(host.status === 403, `a non-loopback Host answered ${host.status}`);
    const origin = await api(fwd.port, 'POST', '/v1/supervisor/pause', { auth: fwd.token, headers: { origin: 'http://evil.example' } });
    check(origin.status === 403, `a write from a non-loopback Origin answered ${origin.status}`);
  } finally {
    await fwd.stop();
  }
});
