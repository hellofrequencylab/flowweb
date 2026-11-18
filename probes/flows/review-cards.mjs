// Probe for FW-C-168 (each flow tests two message angles on purpose, and the weekly review ends in
// accept-or-decline cards): `pnpm probe flows/review-cards`. Tier 0.
// probe-timeout-s: 300
// Surfaces: the daemon fwd on a fresh FW_HOME with the fake engine, the hunt and review routes under
// /v1/flows/neighborhood-activation with the CLI token fwd prints, the flow's files under
// $FW_HOME/flows/neighborhood-activation/ (drafts/, hunts.json, cycles/<fire>/angle-plan.json),
// hosted/relay/fw-relay.mjs, hosted/server/requests.mjs, and the WhatsWorking component exported from
// packages/web/src/flows. The component checks are in probes/flows/review-cards.spec.tsx, run with vitest
// in jsdom against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   GET /v1/flows/{key}/review/proposals -> 200 { data: { flow, proposals: [proposal] } }, for the flow or a
//     copy of it; 404 for a flow with no weekly review.
//   proposal = { id, kind: 'pause' | 'move', text (one plain line), state: 'open' | 'accepted' | 'declined',
//                evidence: { pooled_rate, hunts: [{ name, sent, responded, from, to }] } }
//   A pause shift of the last review is one proposal; all its max_sends shifts together are one "move".
//   POST /v1/flows/{key}/review/proposals/{id} { decision: 'accept' | 'decline' } -> 200 { data: proposal };
//     Owner only (401 without the token), 400 for another decision, 404 for an unknown id, 409 once decided.
//     Accept applies the shifts as the review's own apply does (hunts.json only). Decline changes no hunt and
//     the same proposal is left out of the reviews of the next 30 days.
//   The relay snapshot copies /flows/{key}/review/proposals. On the site the POST travels as the existing
//   request kind flow.edit with payload { review_decision: { id, decision } }.
//   A hunt cycle writes angle-plan.json in its folder: { proven_sends: 8, plan: [{ niche, angles: [a, b],
//   proven }] }, one entry per config niche with two or more angles: the angle with the best reply rate
//   among those with 8 or more sent, then the least-sent other angle; with nothing proven, the two least
//   sent, in config order.
//
// Proves, in order:
//   1. Before any review there are no proposals. After a review of 56 sent drafts there are two open ones: a
//      pause for the hunt with 16 sent and nothing back, and a move of sends between the other two.
//   2. Deciding needs the Owner; a wrong decision, an unknown id are refused.
//   3. Accepting the move changes both hunts' max_sends as the shifts say, never raising their total, marks
//      it accepted, leaves the flow's config alone, and cannot be done twice.
//   4. Declining the pause, sent the way the site sends it (flow.edit carrying review_decision), leaves
//      hunts.json untouched and marks it declined.
//   5. The next review does not raise the declined pause again.
//   6. The relay copies the proposals.
//   7. A hunt run writes angle-plan.json: for "sound" the proven angle (fees, 9 sent, 5 replied) first and
//      the least-tried other (scattered) second; for a niche with no sends, its first two angles.
//   8. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root, tmpDir, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/review-cards';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}`;
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Writes n sent drafts for a hunt; the first `replied` of them were answered. */
function seed(dir, huntId, mark, n, replied, extra = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < n; i++) {
    const id = `${huntId}-${mark}${String(i).padStart(10, '0')}`;
    const doc = {
      flow: KEY,
      id,
      hunt_id: huntId,
      tag: id,
      channel: 'frequency',
      send_via: 'contact_form',
      contact_url: `https://${mark}${i}.${huntId}.example.com/contact`,
      subject: 'Hello',
      body: 'Hi',
      status: 'waiting_for_owner',
      created_at: '2026-11-01T00:00:00.000Z',
      sent_at: '2026-11-02T00:00:00.000Z',
      ...(i < replied ? { replied_at: '2026-11-03T00:00:00.000Z' } : {}),
      ...extra,
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  }
}

await probe(NAME, async () => {
  const home = realpathSync(freshHome('review-cards'));
  const flowDir = join(home, 'flows', KEY);
  const f = await startFwd(home, { env: { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' } });
  try {
    const call = (method, path, body, auth = f.token) => api(f.port, method, path, { auth, body });
    const proposals = async () => (await call('GET', `${BASE}/review/proposals`)).json?.data?.proposals;
    const hunts = () => read(join(flowDir, 'hunts.json')).hunts;

    // ---- 1. proposals after a review with enough sent ----------------------------------------------------
    const first = await call('GET', `${BASE}/review/proposals`);
    if (first.status === 404 || first.status === 405) missing(`GET ${BASE}/review/proposals answered ${first.status} (no proposals route)`);
    check(first.status === 200 && Array.isArray(first.json?.data?.proposals) && first.json.data.proposals.length === 0, `before any review: ${first.status} ${first.text.slice(0, 200)}`);
    check((await call('GET', '/v1/flows/no-such-flow/review/proposals')).status === 404, "an unknown flow's proposals did not answer 404");
    const mk = async (name) => {
      const r = await call('POST', `${BASE}/hunts`, { name, looking_for: name, region: 'north-county-sd', max_sends: 10 });
      check(r.status === 201, `saving hunt ${name} answered ${r.status}: ${r.text.slice(0, 200)}`);
      return r.json.data;
    };
    const A = await mk('Sound baths');
    const B = await mk('Chess clubs');
    const C = await mk('Open mics');
    const drafts = join(flowDir, 'drafts');
    seed(drafts, A.id, 'fees', 9, 5, { niche: 'sound', angle: 'fees' });
    seed(drafts, A.id, 'fill', 8, 0, { niche: 'sound', angle: 'fill_room' });
    seed(drafts, A.id, 'scat', 2, 2, { niche: 'sound', angle: 'scattered' });
    seed(drafts, A.id, 'none', 1, 1);
    seed(drafts, B.id, 'b', 16, 0);
    seed(drafts, C.id, 'c', 20, 1);
    const run = await call('POST', `${BASE}/review/run`);
    check(run.status === 200, `running the review answered ${run.status}: ${run.text.slice(0, 200)}`);
    const open = await proposals();
    const pause = open.find((p) => p.kind === 'pause');
    const move = open.find((p) => p.kind === 'move');
    check(open.length === 2 && pause && move && open.every((p) => p.state === 'open'), `the proposals: ${JSON.stringify(open).slice(0, 400)}`);
    check(pause.text.includes('Chess clubs') && pause.evidence.hunts[0].sent === 16 && pause.evidence.hunts[0].responded === 0, `the pause: ${JSON.stringify(pause)}`);
    check(move.text.includes('Sound baths') && move.text.includes('Open mics') && move.evidence.hunts.length === 2, `the move: ${JSON.stringify(move)}`);
    for (const p of open) {
      check(typeof p.id === 'string' && typeof p.text === 'string' && !p.text.includes('\n') && p.text.length <= 200, `a proposal is not one short line: ${JSON.stringify(p.text)}`);
      check(!/[–—]/.test(p.text), `a proposal has a dash in it: ${p.text}`);
    }

    // ---- 2. only the Owner decides, and only accept or decline --------------------------------------------
    const P = (id) => `${BASE}/review/proposals/${id}`;
    check((await call('POST', P(move.id), { decision: 'accept' }, null)).status === 401, 'deciding without the token was not refused');
    check((await call('POST', P(move.id), { decision: 'send' })).status === 400, 'a decision that is not accept or decline was not refused');
    check((await call('POST', P('shf_000000000000'), { decision: 'accept' })).status === 404, 'an unknown proposal did not answer 404');
    check((await proposals()).every((p) => p.state === 'open'), 'a refused decision changed a proposal');

    // ---- 3. accept applies the shifts ----------------------------------------------------------------------
    const cfgBefore = (await call('GET', `${BASE}/config`)).text.replace(/"as_of":"[^"]*"/, '');
    const before = hunts();
    const ok = await call('POST', P(move.id), { decision: 'accept' });
    check(ok.status === 200 && ok.json?.data?.state === 'accepted', `accepting answered ${ok.status}: ${ok.text.slice(0, 200)}`);
    const after = hunts();
    const sends = (list, h) => list.find((x) => x.id === h.id).max_sends;
    for (const e of move.evidence.hunts) {
      const h = [A, C].find((x) => x.name === e.name);
      check(sends(before, h) === e.from && sends(after, h) === e.to, `"${e.name}" went ${sends(before, h)} to ${sends(after, h)}; the proposal said ${e.from} to ${e.to}`);
    }
    check(sends(after, A) > sends(before, A) && sends(after, C) < sends(before, C), 'the move did not shift sends toward the hunt that gets replies');
    const total = (list) => list.reduce((n, h) => n + h.max_sends, 0);
    check(total(after) <= total(before), `accepting raised the hunts' total sends from ${total(before)} to ${total(after)}`);
    check(after.find((h) => h.id === B.id).enabled !== false, 'accepting the move also paused a hunt');
    check((await call('GET', `${BASE}/config`)).text.replace(/"as_of":"[^"]*"/, '') === cfgBefore, "accepting a proposal changed the flow's config (caps, regions)");
    check((await call('POST', P(move.id), { decision: 'accept' })).status === 409, 'accepting twice did not answer 409');

    // ---- 4. decline, sent the way the site sends it ---------------------------------------------------------
    const { requestOf, fwdCallFor } = await import(join(root, 'hosted/server/requests.mjs'));
    const req = requestOf('POST', `/flows/${KEY}/review/proposals/${pause.id}`, { decision: 'decline' });
    if (!req || req.error) missing(`the site cannot carry a review decision: ${JSON.stringify(req)}`);
    check(req.kind === 'flow.edit' && req.payload?.review_decision?.id === pause.id && req.payload.review_decision.decision === 'decline', `the site's request: ${JSON.stringify(req)}`);
    check(requestOf('POST', `/flows/${KEY}/review/proposals/${pause.id}`, { decision: 'send' })?.error, 'the site accepted a decision that is not accept or decline');
    const viaSite = fwdCallFor(req);
    check(viaSite?.method === 'POST' && viaSite.path === `/flows/${KEY}/review/proposals/${pause.id}`, `the relay's call: ${JSON.stringify(viaSite)}`);
    const hBefore = readFileSync(join(flowDir, 'hunts.json'), 'utf8');
    const no = await call(viaSite.method, `/v1${viaSite.path}`, viaSite.body);
    check(no.status === 200 && no.json?.data?.state === 'declined', `declining answered ${no.status}: ${no.text.slice(0, 200)}`);
    check(readFileSync(join(flowDir, 'hunts.json'), 'utf8') === hBefore, 'declining changed hunts.json');
    const states = Object.fromEntries((await proposals()).map((p) => [p.kind, p.state]));
    check(states.pause === 'declined' && states.move === 'accepted', `after both decisions: ${JSON.stringify(states)}`);

    // ---- 5. the next review does not raise it again -----------------------------------------------------------
    const again = await call('POST', `${BASE}/review/run`);
    check(again.status === 200, `the second review answered ${again.status}`);
    const card = again.json.data.scorecard.hunts.find((h) => h.hunt_id === B.id);
    check(card.sent === 16 && card.responded === 0, `the second review's card for the declined hunt: ${JSON.stringify(card)}`);
    const next = await proposals();
    check(!next.some((p) => p.kind === 'pause'), `the declined pause came back on the next review: ${JSON.stringify(next).slice(0, 300)}`);
    check(hunts().find((h) => h.id === B.id).enabled !== false, 'the declined hunt was paused anyway');

    // ---- 6. the relay copies the proposals ----------------------------------------------------------------------
    const relay = readFileSync(join(root, 'hosted/relay/fw-relay.mjs'), 'utf8');
    check(/\/review\/proposals/.test(relay), 'the hosted relay does not copy /flows/{key}/review/proposals');

    // ---- 7. a hunt run plans two angles per niche ----------------------------------------------------------------
    check((await call('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, `enabling ${KEY} failed`);
    const fired = await call('POST', `${BASE}/hunts/${A.id}/run`);
    check(fired.status === 200, `running the hunt answered ${fired.status}: ${fired.text.slice(0, 200)}`);
    const cycles = join(flowDir, 'cycles');
    const planFile = () => (existsSync(cycles) ? readdirSync(cycles) : []).map((c) => join(cycles, c, 'angle-plan.json')).find((p) => existsSync(p));
    try {
      await waitFor(() => planFile(), { timeoutMs: 30000, everyMs: 250, what: 'the hunt cycle to write angle-plan.json' });
    } catch {
      missing('a hunt cycle wrote no angle-plan.json in its folder');
    }
    const plan = read(planFile());
    const cfg = read(join(root, 'flows', KEY, 'config.json'));
    const two = cfg.niches.filter((n) => n.angles.length >= 2);
    check(plan.proven_sends === 8 && plan.plan.length === two.length, `the plan covers ${plan.plan?.length} niches, want ${two.length}`);
    for (const p of plan.plan) {
      const keys = cfg.niches.find((n) => n.key === p.niche).angles.map((a) => a.key);
      check(p.angles.length === 2 && p.angles[0] !== p.angles[1] && p.angles.every((a) => keys.includes(a)), `the plan for ${p.niche} does not name two of its angles: ${JSON.stringify(p)}`);
    }
    const sound = plan.plan.find((p) => p.niche === 'sound');
    check(sound.proven === 'fees' && sound.angles[0] === 'fees' && sound.angles[1] === 'scattered', `the plan for sound: ${JSON.stringify(sound)}; want fees (proven) then scattered (least tried)`);
    const fresh = plan.plan.find((p) => p.niche === 'breathwork');
    const firstTwo = cfg.niches.find((n) => n.key === 'breathwork').angles.slice(0, 2).map((a) => a.key);
    check(fresh.proven === null && fresh.angles.join() === firstTwo.join(), `the plan for a niche with no sends: ${JSON.stringify(fresh)}; want ${firstTwo}`);
  } finally {
    await f.stop('SIGKILL').catch(() => {});
  }

  // ---- 8. the component --------------------------------------------------------------------------------------------
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('review-cards'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/review-cards.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfgFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the review card checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 review card checks to pass:\n${out.slice(-400)}`);
});
