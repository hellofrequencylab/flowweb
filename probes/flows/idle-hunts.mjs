// Probe for FW-C-157 (a hunt flow with no hunt due ends its cycle without the engine): `pnpm probe flows/idle-hunts`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token, FW_VENDOR=fake, FW_FAKE_SCENARIO=hunt_leads);
// POST /v1/flows/{key}/hunts, POST /v1/flows/{key}/hunts/{id}/run and POST /v1/supervisor/flows/{key}/run;
// status_reports rows of kind run; the drafts folder $FW_HOME/flows/<key>/drafts/.
// Why: a cycle of a flow that has saved hunts, none of them due (each ran in the last day), fell through
// to the brief for a flow with no hunts and asked the engine for one template invite per funnel. That
// spent a turn and left blank-slot template drafts in the Owner's list (12 of them by 2026-11-18).
// The surface this probe expects:
//   When the flow has at least one enabled hunt and none is due, the cycle ends at once: its run report
//   says outcome "dry", drafts 0, adapter "none" and a reason starting "no hunt is due". No draft file is
//   written. A hunt asked for by hand still runs, and a flow with no saved hunts drafts as before.
//
// Proves, in order:
//   1. A hunt run by hand drafts for its leads.
//   2. Running the flow again right after, with that hunt not due, ends dry without the engine and
//      writes no draft.
//   3. The hunt, asked for by hand again, still runs on the engine.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, openDbReadonly, probe, waitFor } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/idle-hunts';
const ROW = 'FW-C-157';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/hunts`;
const ENV = { FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' };

await probe(NAME, async () => {
  const home = realpathSync(freshHome('idle-hunts'));
  const f = await startFwd(home, { env: ENV });
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, body });
    const dir = join(home, 'flows', KEY, 'drafts');
    const files = () => (existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []);
    const reports = async () => {
      const db = await openDbReadonly(home);
      try {
        return db
          .prepare("SELECT body FROM status_reports WHERE kind = 'run' ORDER BY created_at")
          .all()
          .map((r) => JSON.parse(r.body));
      } finally {
        db.close();
      }
    };
    async function fired(path, what) {
      const run = await call('POST', path);
      check(run.status === 200, `${what} answered ${run.status}: ${run.text.slice(0, 200)}`);
      const rd = run.json?.data;
      check(rd?.outcome === 'fired', `${what}: outcome ${rd?.outcome} (${rd?.reason ?? ''}), want fired`);
      let rep;
      await waitFor(
        async () => {
          rep = (await reports()).find((b) => b.fire_id === rd.fire_id);
          return rep !== undefined;
        },
        { timeoutMs: 30000, everyMs: 250, what: `${what} to write its run report` },
      );
      return rep;
    }

    const en = await call('POST', `/v1/supervisor/flows/${KEY}/enable`);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}: ${en.text.slice(0, 200)}`);
    const made = await call('POST', BASE, {
      name: 'Sound baths in Encinitas',
      looking_for: 'sound baths and breathwork workshops',
      region: 'north-county-sd',
      max_sends: 1,
    });
    check(made.status === 201, `saving a hunt answered ${made.status}: ${made.text.slice(0, 200)}`);
    const hunt = made.json?.data;

    // ---- 1. a hunt run by hand ------------------------------------------------------------------------
    const r1 = await fired(`${BASE}/${hunt.id}/run`, 'running the hunt');
    check(r1.outcome === 'drafted' && r1.drafts === 1, `the hunt run: ${JSON.stringify(r1).slice(0, 300)}`);
    const before = files();
    check(before.length === 1, `drafts after the hunt run: ${before.length}, want 1`);

    // ---- 2. the flow runs again with nothing due --------------------------------------------------------
    const r2 = await fired(`/v1/supervisor/flows/${KEY}/run`, 'running the flow with no hunt due');
    if (r2.adapter !== 'none')
      missing(`a cycle with no hunt due still called the engine (adapter ${r2.adapter}) (row ${ROW})`);
    check(r2.outcome === 'dry' && r2.drafts === 0, `the idle cycle: ${JSON.stringify(r2).slice(0, 300)}`);
    check(/^no hunt is due/.test(r2.reason ?? ''), `the idle cycle's reason: ${JSON.stringify(r2.reason)}`);
    check(JSON.stringify(files()) === JSON.stringify(before), `the idle cycle wrote drafts: ${JSON.stringify(files())}`);

    // ---- 3. asked for by hand, the hunt still runs --------------------------------------------------------
    const r3 = await fired(`${BASE}/${hunt.id}/run`, 'running the hunt again');
    check(r3.adapter === 'fake', `a hunt asked for by hand ran on ${r3.adapter}, want the engine`);
    check(Array.isArray(r3.hunts) && r3.hunts.some((h) => h.id === hunt.id), `the second hunt run: ${JSON.stringify(r3).slice(0, 300)}`);
  } finally {
    await f.stop();
  }
});
