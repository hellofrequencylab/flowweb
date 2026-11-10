// Running a flow by hand that cannot run says why: a flow whose project fwd does not know is never
// registered, so "turn it on first" would send the Owner in a circle.
import { afterAll, expect, test } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.ts';
import { call, tempHome } from './api-fixtures.ts';

const home = tempHome();
let d: Daemon | undefined;
afterAll(async () => {
  await d?.stop();
  home.cleanup();
});

test('a flow with no project says it cannot run, not "turn it on first"', async () => {
  d = await startDaemon({ fwHome: home.path, port: 0, devNoAuth: true, log: () => {} });
  const on = await call(d.port, 'POST', '/v1/supervisor/flows/local-saturation/enable', { body: {} });
  expect(on.status).toBe(200);
  const run = await call(d.port, 'POST', '/v1/supervisor/flows/local-saturation/run', { body: {} });
  expect(run.status).toBe(404);
  expect(JSON.stringify(run.json)).toContain(
    'local-saturation cannot run: its project prj_frequency1 is not set up',
  );
  expect(JSON.stringify(run.json)).not.toContain('turn it on first');
});
