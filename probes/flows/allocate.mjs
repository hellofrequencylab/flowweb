// Probe for FW-C-135 (the Supervisor splits the daily new-people slots across flows by results):
// `pnpm probe flows/allocate`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/daemon/src/overseer/allocate.ts (pure), a real fwd on a fresh FW_HOME (CLI token and
// a paired browser session), GET /v1/supervisor, POST /v1/supervisor/allocation and
// POST /v1/supervisor/allocation/apply, and each flow's intensity in its FlowView.
//
// The surface this probe expects:
//   allocate(total, flows) is pure. flows is [{ key, enabled, sent, responded }] (sent and responded from
//     the last 30 days, as recentResults counts them). It answers { by_flow: { [key]: n }, why: { [key]: text } }:
//     a flow that is off gets 0; the enabled flows share exactly total, each keeps at least 1; a flow with
//     fewer than 8 sends counts as no data, and flows with no data split evenly (any remainder one each,
//     in key order); among flows with data, a better response rate never gets fewer slots than a worse
//     one. Every enabled flow has a non-empty why. No enabled flow: by_flow is all 0.
//   GET /v1/supervisor has allocation: { total, by_flow, why, applied }. total is the Owner's daily number
//     (default 10). by_flow covers the flows that take new people a day (neighborhood-activation and
//     local-saturation among them). applied is false until the Owner applies it: a split is a proposal and
//     never moves a flow's per_day by itself.
//   POST /v1/supervisor/allocation { total } sets total (whole, 1 to 100); bad 400; no session 401.
//   POST /v1/supervisor/allocation/apply (CLI token or paired session) writes each flow's share as its
//     intensity per_day, and allocation.applied turns true until the split changes.
//
// Proves, in order:
//   1. The pure split: even with no data, toward results with data, never zero for an enabled flow.
//   2. A real fwd proposes 5 and 5 for two flows that are on, and nothing moves until applied.
//   3. The Owner changes the total and applies it; each flow's per_day follows.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/allocate';
const A = 'local-saturation';
const B = 'neighborhood-activation';
const S = '/v1/supervisor';
const sum = (o) => Object.values(o).reduce((a, n) => a + n, 0);

await probe(NAME, async () => {
  // ---- 1. the pure split --------------------------------------------------------------------------------
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, 'packages/daemon/src/overseer/allocate.ts')).href);
  } catch {
    missing('packages/daemon/src/overseer/allocate.ts does not exist (row FW-C-135)');
  }
  if (typeof mod.allocate !== 'function') missing('allocate.ts does not export allocate (row FW-C-135)');
  const flow = (key, enabled, sent = 0, responded = 0) => ({ key, enabled, sent, responded });

  let r = mod.allocate(10, [flow('a', true), flow('b', true), flow('c', false)]);
  check(r.by_flow.a === 5 && r.by_flow.b === 5 && r.by_flow.c === 0, `no data, two on, one off: ${JSON.stringify(r.by_flow)}`);
  check(typeof r.why.a === 'string' && r.why.a.length > 0 && typeof r.why.b === 'string' && r.why.b.length > 0, 'an enabled flow has no why');
  r = mod.allocate(10, [flow('a', true), flow('b', true), flow('c', true)]);
  check(sum(r.by_flow) === 10 && r.by_flow.a === 4 && r.by_flow.b === 3 && r.by_flow.c === 3, `no data, three on: ${JSON.stringify(r.by_flow)}`);
  r = mod.allocate(10, [flow('a', true, 40, 8), flow('b', true, 40, 1)]);
  check(sum(r.by_flow) === 10, `with data the split does not add up to 10: ${JSON.stringify(r.by_flow)}`);
  check(r.by_flow.a > r.by_flow.b && r.by_flow.b >= 1, `8 of 40 against 1 of 40 split ${JSON.stringify(r.by_flow)}`);
  r = mod.allocate(10, [flow('a', true, 2, 2), flow('b', true, 40, 4)]);
  check(r.by_flow.a === 5 && r.by_flow.b === 5, `2 sends is no data, so the split stays even: ${JSON.stringify(r.by_flow)}`);
  r = mod.allocate(3, [flow('a', true, 50, 10), flow('b', true, 50, 0), flow('c', true, 50, 0)]);
  check(r.by_flow.a === 1 && r.by_flow.b === 1 && r.by_flow.c === 1, `every enabled flow keeps at least 1: ${JSON.stringify(r.by_flow)}`);
  r = mod.allocate(10, [flow('a', false), flow('b', false)]);
  check(sum(r.by_flow) === 0, `nothing on still allocated ${JSON.stringify(r.by_flow)}`);

  // ---- 2. a real fwd proposes ----------------------------------------------------------------------------
  const home = realpathSync(freshHome('allocate'));
  const f = await startFwd(home);
  try {
    const sup = async () => (await api(f.port, 'GET', S, { auth: f.token })).json?.data;
    const post = (path, body, auth = f.token) => api(f.port, 'POST', `${S}${path}`, { auth, body: body ?? {} });
    const first = await sup();
    if (!first?.allocation) missing('GET /v1/supervisor has no allocation (row FW-C-135)');
    check(first.allocation.total === 10 && first.allocation.applied === false, `a fresh allocation: ${JSON.stringify(first.allocation)}`);
    check(sum(first.allocation.by_flow) === 0, `with every flow off the split is ${JSON.stringify(first.allocation.by_flow)}`);
    for (const k of [A, B]) check((await post(`/flows/${k}/enable`)).status === 200, `turning ${k} on was refused`);
    const before = Object.fromEntries((await sup()).flows.map((x) => [x.key, x.intensity?.per_day]));
    const al = (await sup()).allocation;
    check(al.by_flow[A] === 5 && al.by_flow[B] === 5, `two flows on with no data: ${JSON.stringify(al.by_flow)}`);
    check(al.applied === false && al.why[A] && al.why[B], `the proposal: ${JSON.stringify(al)}`);
    const still = Object.fromEntries((await sup()).flows.map((x) => [x.key, x.intensity?.per_day]));
    check(JSON.stringify(still) === JSON.stringify(before), 'a proposed split moved a per_day by itself');

    // ---- 3. the Owner sets the total and applies -----------------------------------------------------------
    const none = await post('/allocation', { total: 12 }, null);
    if (none.status === 404 && /no route/i.test(none.text)) missing(`POST ${S}/allocation does not exist (row FW-C-135)`);
    check(none.status === 401, `setting the total without a session answered ${none.status}, want 401`);
    for (const bad of [0, 101, 2.5, 'ten']) check((await post('/allocation', { total: bad })).status === 400, `a total of ${JSON.stringify(bad)} was not 400`);
    const { cookie } = await pair(f.port, f.pairingCode);
    check((await post('/allocation', { total: 12 }, { cookie })).status === 200, 'setting the total to 12 was refused');
    const twelve = (await sup()).allocation;
    check(twelve.total === 12 && twelve.by_flow[A] === 6 && twelve.by_flow[B] === 6, `a total of 12: ${JSON.stringify(twelve)}`);
    const ap = await post('/allocation/apply', {}, { cookie });
    check(ap.status === 200, `applying answered ${ap.status}: ${ap.text.slice(0, 200)}`);
    const after = await sup();
    check(after.allocation.applied === true, 'applied is still false after applying');
    for (const k of [A, B]) {
      const v = after.flows.find((x) => x.key === k);
      check(v?.intensity?.per_day === 6, `after applying ${k} per_day is ${v?.intensity?.per_day}, want 6`);
    }
  } finally {
    await f.stop();
  }
});
