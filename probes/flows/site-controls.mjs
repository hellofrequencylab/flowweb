// Probe for FW-C-062 (the Owner runs a flow from the web and from flowweb.app): `pnpm probe flows/site-controls`.
// probe-timeout-s: 420
// Tier 0.
// Surfaces: hosted/server/requests.mjs (pure: which site calls become queued requests, and which fwd call
// the relay makes for each), hosted/supabase/migrations/0004_flowweb_flow_controls.sql, a real fwd on a
// fresh FW_HOME with a paired browser session (cookie), and the built web UI served by that fwd.
//
// The surface this probe expects:
//   requestOf(method, path, body) -> { kind, flow, draft_id, payload } | { error } | null
//     POST /supervisor/pause | /supervisor/resume                    -> supervisor.pause | supervisor.resume (flow 'all')
//     POST /supervisor/flows/{key}/enable | disable | run             -> flow.enable | flow.disable | flow.run
//     POST /supervisor/flows/{key}/dial { stop: draft|copilot }       -> flow.dial; autopilot is refused ({ error })
//     POST /supervisor/flows/{key}/drafts/{id}/approve                -> draft.approve (the existing draft kinds stay)
//     POST /flows/{key}/hunts { name, looking_for, region, ... }      -> hunt.save
//     POST /flows/{key}/hunts/{id}/run, DELETE /flows/{key}/hunts/{id} -> hunt.run, hunt.remove (draft_id = hunt id)
//     POST /flows/{key}/do-not-contact { email, reason }              -> flow.block
//   fwdCallFor(request) -> { method, path, body } naming the same fwd route (under /v1) the site call named.
//   Migration 0004 allows every one of those kinds and lets draft_id be empty.
//   fwd answers the Supervisor controls to the paired browser session as well as the CLI token.
//   The Flows page (/flows) has, per flow, a button named "Turn on <flow name>" (or "Turn off <flow name>")
//   and a radio group named "Dial for <flow name>" with the radios Draft, Copilot and Autopilot.
//
// Proves, in order:
//   1. Every site control becomes a queued request of the right kind; Autopilot and unknown paths do not.
//   2. For every request kind, the relay's fwd call is the route the site called, with the same body.
//   3. Migration 0004 allows every kind requestOf can produce and lets draft_id be empty.
//   4. A paired browser session can turn a flow on and set it to Copilot; Autopilot without the confirm
//      hash answers 409; with no session or token the control answers 401.
//   5. On the Flows page, the Owner turns Neighborhood activation off and on again and moves its dial to
//      Draft, and GET /v1/supervisor shows each change.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, pair } from '../lib/fwd.mjs';
import { browser, pairedPage, startUi } from '../lib/web.mjs';

const NAME = 'flows/site-controls';
const KEY = 'neighborhood-activation';
const FLOW_NAME = 'Neighborhood activation';
const MIGRATION = 'hosted/supabase/migrations/0004_flowweb_flow_controls.sql';

const flowOf = (sup) => (sup?.flows ?? []).find((f) => f.key === KEY);

await probe(NAME, async () => {
  // 1. Site calls become requests.
  const mod = await import(pathToFileURL(join(root, 'hosted/server/requests.mjs')).href);
  if (typeof mod.requestOf !== 'function') missing('hosted/server/requests.mjs does not export requestOf (row FW-C-062)');
  const { requestOf, fwdCallFor } = mod;
  const S = `/supervisor/flows/${KEY}`;
  const F = `/flows/${KEY}`;
  const hunt = {
    name: 'Probe hunt',
    looking_for: 'community events',
    region: 'north-county',
    links: [],
    every_days: 1,
    max_sends: 5,
    build: false,
  };
  const cases = [
    ['POST', '/supervisor/pause', {}, 'supervisor.pause', 'all', null, {}],
    ['POST', '/supervisor/resume', {}, 'supervisor.resume', 'all', null, {}],
    ['POST', `${S}/enable`, {}, 'flow.enable', KEY, null, {}],
    ['POST', `${S}/disable`, {}, 'flow.disable', KEY, null, {}],
    ['POST', `${S}/run`, {}, 'flow.run', KEY, null, {}],
    ['POST', `${S}/dial`, { stop: 'copilot' }, 'flow.dial', KEY, null, { stop: 'copilot' }],
    ['POST', `${S}/dial`, { stop: 'draft', extra: 1 }, 'flow.dial', KEY, null, { stop: 'draft' }],
    ['POST', `${S}/drafts/d_1/approve`, {}, 'draft.approve', KEY, 'd_1', {}],
    ['POST', `${S}/drafts/d_1/reject`, {}, 'draft.reject', KEY, 'd_1', {}],
    ['POST', `${F}/hunts`, { ...hunt, sneaky: true }, 'hunt.save', KEY, null, hunt],
    ['POST', `${F}/hunts/hnt_abc123/run`, {}, 'hunt.run', KEY, 'hnt_abc123', {}],
    ['DELETE', `${F}/hunts/hnt_abc123`, undefined, 'hunt.remove', KEY, 'hnt_abc123', {}],
    [
      'POST',
      `${F}/do-not-contact`,
      { email: 'x@example.org', reason: 'said no' },
      'flow.block',
      KEY,
      null,
      { email: 'x@example.org', reason: 'said no' },
    ],
  ];
  const kinds = new Set();
  for (const [method, path, body, kind, flow, draftId, payload] of cases) {
    const r = requestOf(method, path, body);
    check(r && !r.error, `${method} ${path} did not become a request: ${JSON.stringify(r)}`);
    check(r.kind === kind, `${method} ${path} became ${r.kind}, want ${kind}`);
    check(r.flow === flow, `${method} ${path} names flow ${r.flow}, want ${flow}`);
    check((r.draft_id ?? null) === draftId, `${method} ${path} names item ${r.draft_id}, want ${draftId}`);
    check(
      JSON.stringify(r.payload) === JSON.stringify(payload),
      `${method} ${path} carries ${JSON.stringify(r.payload)}, want ${JSON.stringify(payload)}`,
    );
    kinds.add(kind);

    // 2. And back to the same fwd route.
    const call = fwdCallFor({ id: 'r1', ...r });
    check(call, `the relay has no fwd call for ${kind}`);
    check(call.method === method, `${kind}: relay calls ${call.method}, want ${method}`);
    check(call.path === path, `${kind}: relay calls ${call.path}, want ${path}`);
    const want = method === 'DELETE' ? undefined : JSON.stringify(payload);
    check(
      (call.body === undefined ? undefined : JSON.stringify(call.body)) === want,
      `${kind}: relay sends ${JSON.stringify(call.body)}, want ${want}`,
    );
  }
  const refused = [
    ['POST', `${S}/dial`, { stop: 'autopilot' }],
    ['POST', `${S}/dial`, { stop: 'max' }],
    ['POST', `${F}/do-not-contact`, { reason: 'no address' }],
    ['POST', `${F}/hunts`, {}],
  ];
  for (const [method, path, body] of refused) {
    const r = requestOf(method, path, body);
    check(r?.error, `${method} ${path} ${JSON.stringify(body)} should be refused, got ${JSON.stringify(r)}`);
  }
  for (const [method, path] of [
    ['POST', '/supervisor/flows/../enable'],
    ['POST', '/kill-switch/release'],
    ['POST', `${S}/budget`],
    ['GET', `${S}/enable`],
  ]) {
    const r = requestOf(method, path, {});
    check(r === null || r?.error, `${method} ${path} became a request: ${JSON.stringify(r)}`);
  }
  check(fwdCallFor({ kind: 'flow.delete', flow: KEY, draft_id: null, payload: {} }) === null, 'unknown kinds must have no fwd call');
  check(fwdCallFor({ kind: 'flow.dial', flow: KEY, draft_id: null, payload: { stop: 'autopilot' } }) === null, 'Autopilot must have no fwd call from the site');

  // 3. The migration.
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-062)`);
  const sql = readFileSync(mig, 'utf8');
  for (const k of [...kinds, 'draft.edit', 'draft.rewrite', 'draft.mark'])
    check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);
  check(/draft_id\s+drop\s+not\s+null/i.test(sql), `${MIGRATION} does not let draft_id be empty`);

  // 4 and 5. A real fwd, its paired browser session, and the Flows page.
  const home = freshHome('site-controls');
  const ui = await startUi(home, { env: { FW_VENDOR: 'fake' } });
  const br = await browser();
  try {
    const sup = async () => (await api(ui.port, 'GET', '/v1/supervisor', { auth: ui.token })).json?.data;
    const none = await api(ui.port, 'POST', `/v1${S}/enable`, { body: {} });
    check(none.status === 401, `enable without a session or token answered ${none.status}, want 401`);

    const { cookie } = await pair(ui.port, ui.pairingCode);
    const on = await api(ui.port, 'POST', `/v1${S}/enable`, { auth: { cookie }, body: {} });
    check(on.status === 200, `enable with the browser session answered ${on.status}: ${on.text.slice(0, 200)}`);
    check(flowOf(await sup())?.enabled === true, 'after enable the Supervisor does not list the flow as on');
    const co = await api(ui.port, 'POST', `/v1${S}/dial`, { auth: { cookie }, body: { stop: 'copilot' } });
    check(co.status === 200, `dial copilot with the browser session answered ${co.status}: ${co.text.slice(0, 200)}`);
    check(flowOf(await sup())?.dial === 'copilot', 'after dial copilot the Supervisor does not show Copilot');
    const auto = await api(ui.port, 'POST', `/v1${S}/dial`, { auth: { cookie }, body: { stop: 'autopilot' } });
    check(auto.status === 409, `Autopilot without the confirm hash answered ${auto.status}, want 409`);

    const page = await pairedPage(ui, br, { width: 1280, height: 900 });
    await page.goto(`${ui.base}/flows`);
    await page.locator('main').first().waitFor({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    const off = page.getByRole('button', { name: `Turn off ${FLOW_NAME}` });
    if ((await off.count()) === 0) missing(`the Flows page has no "Turn off ${FLOW_NAME}" button (row FW-C-062)`);
    await off.first().click();
    await page.getByRole('button', { name: `Turn on ${FLOW_NAME}` }).first().waitFor({ timeout: 15000 });
    check(flowOf(await sup())?.enabled === false, 'after "Turn off" on the Flows page the flow is still on');
    await page.getByRole('button', { name: `Turn on ${FLOW_NAME}` }).first().click();
    await page.getByRole('button', { name: `Turn off ${FLOW_NAME}` }).first().waitFor({ timeout: 15000 });
    check(flowOf(await sup())?.enabled === true, 'after "Turn on" on the Flows page the flow is still off');

    const dial = page.getByRole('radiogroup', { name: `Dial for ${FLOW_NAME}` }).first();
    check((await dial.count()) === 1, `the Flows page has no "Dial for ${FLOW_NAME}" radio group`);
    for (const word of ['Draft', 'Copilot', 'Autopilot'])
      check((await dial.getByRole('radio', { name: word }).count()) === 1, `the dial has no ${word} radio`);
    await dial.getByRole('radio', { name: 'Draft' }).click();
    const until = Date.now() + 15000;
    while (flowOf(await sup())?.dial !== 'draft' && Date.now() < until) await page.waitForTimeout(250);
    check(flowOf(await sup())?.dial === 'draft', 'after choosing Draft on the Flows page the dial did not move');
    const errs = page.fwErrors ?? [];
    check(errs.length === 0, `the Flows page threw: ${errs.join('; ').slice(0, 300)}`);
    await page.context().close();
  } finally {
    await br.close();
    await ui.stop();
  }
});
