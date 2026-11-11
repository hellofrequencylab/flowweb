// Probe for FW-C-139 (skills that earn their keep: one shared A/B engine, and a flow's champion setting is
// replaced only by a challenger that wins a fair test on real results): `pnpm probe flows/ab-tests`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/daemon/src/skills/ab.ts (pure), a real fwd on a fresh FW_HOME (CLI token and a paired
// browser session), and the test routes under /v1/supervisor/flows/{key}/tests.
//
// The surface this probe expects:
//   assign(testId, subjectId, arms) is pure: the same three inputs always give the same arm, and over many
//     subjects each of two arms gets between 40% and 60%.
//   verdict({ champion: { sent, results }, challenger: { sent, results } }) is pure plain code (no model):
//     { winner: 'challenger' | 'champion' | null, why }. Both arms need at least 30 sends, else null. The
//     challenger wins only when its result rate is higher and the two-proportion z score is at least 1.96;
//     the champion wins when the same holds the other way; anything else is null (keep testing). why is a
//     sentence that names both arms' counts.
//   POST /v1/supervisor/flows/{key}/tests { field, challenger } (CLI token or paired session) starts a test
//     on one string field of the flow's effective config: champion is the current value. It answers 200
//     { data: { id, field, champion, challenger, status: 'running' } }. No session 401; unknown flow 404; a
//     field the config does not have, or that is not a string, 400; a second running test on the same field 409.
//   GET /v1/supervisor/flows/{key}/tests lists tests, each with arms: { champion: { sent, results },
//     challenger: { sent, results } } counted from the drafts each arm made, and verdict as above.
//   POST /v1/supervisor/flows/{key}/tests/{id}/promote replaces the champion with the challenger only when
//     the verdict's winner is challenger; otherwise 409 and the config is unchanged.
//
// Proves, in order:
//   1. Assignment is stable and fair.
//   2. The verdict waits for enough sends and a real difference.
//   3. A real fwd starts a test, refuses what it should, and will not promote a challenger that has not won.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/ab-tests';
const KEY = 'neighborhood-activation';

await probe(NAME, async () => {
  let ab;
  try {
    ab = await import(pathToFileURL(join(root, 'packages/daemon/src/skills/ab.ts')).href);
  } catch {
    missing('packages/daemon/src/skills/ab.ts does not exist (row FW-C-139)');
  }
  if (typeof ab.assign !== 'function' || typeof ab.verdict !== 'function') missing('ab.ts does not export assign and verdict (row FW-C-139)');

  // ---- 1. stable and fair --------------------------------------------------------------------------------
  const arms = ['champion', 'challenger'];
  check(ab.assign('tst_1', 'lead_42', arms) === ab.assign('tst_1', 'lead_42', arms), 'the same subject got two arms');
  let n = 0;
  for (let i = 0; i < 2000; i++) if (ab.assign('tst_1', `lead_${i}`, arms) === 'challenger') n++;
  check(n >= 800 && n <= 1200, `2000 subjects put ${n} in the challenger arm, want 800 to 1200`);

  // ---- 2. the verdict --------------------------------------------------------------------------------------
  const v = (c, x) => ab.verdict({ champion: { sent: c[0], results: c[1] }, challenger: { sent: x[0], results: x[1] } });
  let r = v([29, 1], [29, 20]);
  check(r.winner === null, `29 sends an arm already decided: ${JSON.stringify(r)}`);
  r = v([100, 4], [100, 9]);
  check(r.winner === null, `4 of 100 against 9 of 100 is not a real difference yet, but the verdict is ${r.winner}`);
  check(typeof r.why === 'string' && /\b4\b/.test(r.why) && /\b9\b/.test(r.why), `why does not name both arms: ${r.why}`);
  r = v([100, 4], [100, 16]);
  check(r.winner === 'challenger', `4 of 100 against 16 of 100: ${JSON.stringify(r)}`);
  r = v([100, 16], [100, 4]);
  check(r.winner === 'champion', `16 of 100 against 4 of 100: ${JSON.stringify(r)}`);

  // ---- 3. a real fwd ------------------------------------------------------------------------------------
  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  const field = Object.keys(cfg).find((k) => typeof cfg[k] === 'string' && k !== 'version');
  const notString = Object.keys(cfg).find((k) => typeof cfg[k] === 'object' && cfg[k] !== null);
  check(field && notString, `the ${KEY} config has no string field and object field to test with`);
  const home = realpathSync(freshHome('ab-tests'));
  const f = await startFwd(home);
  try {
    const T = `/v1/supervisor/flows/${KEY}/tests`;
    const post = (path, body, auth = f.token) => api(f.port, 'POST', path, { auth, body: body ?? {} });
    const none = await post(T, { field, challenger: 'A new opener.' }, null);
    if (none.status === 404 && /no route/i.test(none.text)) missing(`POST ${T} does not exist (row FW-C-139)`);
    check(none.status === 401, `starting a test without a session answered ${none.status}, want 401`);
    check((await post('/v1/supervisor/flows/no-such-flow/tests', { field, challenger: 'x' })).status === 404, 'a test on an unknown flow was not 404');
    check((await post(T, { field: 'no_such_field', challenger: 'x' })).status === 400, 'a test on an unknown field was not 400');
    check((await post(T, { field: notString, challenger: 'x' })).status === 400, 'a test on a field that is not a string was not 400');
    const { cookie } = await pair(f.port, f.pairingCode);
    const made = await post(T, { field, challenger: 'A new opener.' }, { cookie });
    check(made.status === 200, `starting a test answered ${made.status}: ${made.text.slice(0, 200)}`);
    const t = made.json?.data;
    check(t?.field === field && t.champion === cfg[field] && t.challenger === 'A new opener.' && t.status === 'running', `the test: ${JSON.stringify(t)}`);
    check((await post(T, { field, challenger: 'Another opener.' })).status === 409, 'a second running test on the same field was not 409');
    const list = await api(f.port, 'GET', T, { auth: f.token });
    const lt = (list.json?.data ?? []).find((x) => x.id === t.id);
    check(lt?.arms?.champion?.sent === 0 && lt.arms.challenger?.sent === 0 && lt.verdict?.winner === null, `a new test lists as ${JSON.stringify(lt)}`);
    const pro = await post(`${T}/${t.id}/promote`);
    check(pro.status === 409, `promoting a challenger that has not won answered ${pro.status}, want 409`);
    check(JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'))[field] === cfg[field], 'a refused promotion changed the config');
  } finally {
    await f.stop();
  }
});
