// Probe for FW-C-131 (trust you can see: every draft card shows its lane's real track record, whether a
// second cheap check agrees, the rows behind it, and a receipt once it goes out; lanes switch off one by
// one; no confidence percentages): `pnpm probe flows/trust-cards`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token and a paired browser session), the Copilot draft routes
// under /v1/supervisor/flows/{key}/drafts (list, approve, mark), the lane routes under
// /v1/supervisor/flows/{key}/lanes, and draft files the probe writes into
// $FW_HOME/flows/neighborhood-activation/drafts/ before fwd starts.
//
// The surface this probe expects:
//   A draft's lane is "<channel>:<hunt_id>" ("<channel>:all" when it has no hunt).
//   Every draft in GET /v1/supervisor/flows/{key}/drafts has trust: { lane, record, second_check, evidence }:
//     record is { approved, rejected, regrets } counted from the flow's other drafts in the same lane
//     (approved: has approved_at; rejected: status rejected; regrets: sent drafts whose person declined or that
//     the Owner marked a regret); evidence lists the ids of the drafts counted; second_check is 'agree',
//     'disagree' or null when no second check ran. Nothing in trust is a percentage or a confidence score.
//   A draft the Owner marks sent (POST .../drafts/{id}/mark { outcome: sent }) carries receipt: { at, channel,
//     to, body_sha256 } (the sha256 of the body that went out); a draft that has not gone out has receipt null.
//   POST /v1/supervisor/flows/{key}/lanes/{lane}/off and .../on (CLI token or paired session; none 401)
//     switch one lane; GET /v1/supervisor/flows/{key}/lanes lists [{ lane, on, record }]. Approving a draft in
//     a lane that is off answers 409 and changes nothing; other lanes are untouched.
//
// Proves, in order:
//   1. The track record is counted per lane, with its evidence and no percentages.
//   2. A sent draft has a receipt that matches what went out.
//   3. Switching one lane off blocks approvals in that lane only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/trust-cards';
const KEY = 'neighborhood-activation';
const LANE = 'email:hnt_vista';
const DAY = 86_400_000;

function seedDrafts(home, now) {
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const iso = (d) => new Date(now - d * DAY).toISOString();
  const lane = { channel: 'email', hunt_id: 'hnt_vista' };
  const drafts = [
    { id: 'drf_v1', ...lane, status: 'handed_off', approved_at: iso(5), sent_at: iso(5) },
    { id: 'drf_v2', ...lane, status: 'handed_off', approved_at: iso(4), sent_at: iso(4) },
    { id: 'drf_v3', ...lane, status: 'handed_off', approved_at: iso(3), sent_at: iso(3), declined_at: iso(2) },
    { id: 'drf_v4', ...lane, status: 'rejected', rejected_at: iso(3) },
    { id: 'drf_v5', ...lane, status: 'waiting_for_owner', to: 'host@example.com' },
    { id: 'drf_o1', channel: 'email', hunt_id: 'hnt_oceanside', status: 'waiting_for_owner', to: 'o@example.com' },
  ];
  for (const d of drafts) {
    const doc = { created_at: iso(6), subject: 'Hello', body: `Hello from the probe, ${d.id}.`, ...d };
    writeFileSync(join(dir, `${d.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

const outboxFiles = (home) => {
  const dir = join(home, 'outbox');
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((x) => String(x).endsWith('.json')) : [];
};

await probe(NAME, async () => {
  const home = realpathSync(freshHome('trust-cards'));
  seedDrafts(home, Date.now());
  const f = await startFwd(home);
  try {
    const D = `/v1/supervisor/flows/${KEY}/drafts`;
    const L = `/v1/supervisor/flows/${KEY}/lanes`;
    const drafts = async () => {
      const r = await api(f.port, 'GET', D, { auth: f.token });
      check(r.status === 200, `GET drafts answered ${r.status}`);
      return Object.fromEntries((r.json?.data ?? []).map((d) => [d.id, d]));
    };

    // ---- 1. track record per lane ------------------------------------------------------------------------
    let d = await drafts();
    if (!d.drf_v5 || !('trust' in d.drf_v5)) missing('a draft has no trust field (row FW-C-131)');
    const t = d.drf_v5.trust;
    check(t.lane === LANE, `drf_v5's lane is ${t.lane}, want ${LANE}`);
    check(t.record?.approved === 3 && t.record.rejected === 1 && t.record.regrets === 1, `the ${LANE} record is ${JSON.stringify(t.record)}, want 3 approved, 1 rejected, 1 regret`);
    check(['drf_v1', 'drf_v2', 'drf_v3', 'drf_v4'].every((id) => t.evidence?.includes(id)) && !t.evidence.includes('drf_o1'), `the evidence is ${JSON.stringify(t.evidence)}`);
    check(t.second_check === null || ['agree', 'disagree'].includes(t.second_check), `second_check is ${JSON.stringify(t.second_check)}`);
    const o = d.drf_o1.trust;
    check(o?.lane === 'email:hnt_oceanside' && o.record?.approved === 0 && o.evidence?.length === 0, `the other lane's trust is ${JSON.stringify(o)}`);
    for (const x of Object.values(d)) {
      const s = JSON.stringify(x.trust ?? {});
      check(!/confidence|probab|percent/i.test(s) && !/\d\s*%/.test(s), `${x.id}'s trust shows a confidence figure: ${s}`);
    }
    check(d.drf_v5.receipt === null, `a waiting draft has a receipt: ${JSON.stringify(d.drf_v5.receipt)}`);

    // ---- 2. a receipt ------------------------------------------------------------------------------------
    const m = await api(f.port, 'POST', `${D}/drf_o1/mark`, { auth: f.token, body: { outcome: 'sent' } });
    check(m.status === 200, `marking drf_o1 sent answered ${m.status}`);
    d = await drafts();
    const rc = d.drf_o1.receipt;
    const sha = createHash('sha256').update(d.drf_o1.body).digest('hex');
    check(rc && typeof rc.at === 'string' && rc.channel === 'email' && rc.to === 'o@example.com' && rc.body_sha256 === sha, `the receipt is ${JSON.stringify(rc)}`);

    // ---- 3. one lane off -----------------------------------------------------------------------------------
    const none = await api(f.port, 'POST', `${L}/${encodeURIComponent(LANE)}/off`, { body: {} });
    if (none.status === 404 && /no route/i.test(none.text)) missing(`POST ${L}/{lane}/off does not exist (row FW-C-131)`);
    check(none.status === 401, `switching a lane without a session answered ${none.status}, want 401`);
    const { cookie } = await pair(f.port, f.pairingCode);
    check((await api(f.port, 'POST', `${L}/${encodeURIComponent(LANE)}/off`, { auth: { cookie }, body: {} })).status === 200, 'switching the lane off was refused');
    const lanes = (await api(f.port, 'GET', L, { auth: f.token })).json?.data ?? [];
    check(lanes.find((x) => x.lane === LANE)?.on === false, `the lanes list says ${JSON.stringify(lanes)}`);
    check(lanes.find((x) => x.lane === 'email:hnt_oceanside')?.on !== false, 'switching one lane off switched another');
    const before = outboxFiles(home).length;
    const ap = await api(f.port, 'POST', `${D}/drf_v5/approve`, { auth: f.token, body: {} });
    check(ap.status === 409, `approving a draft in a lane that is off answered ${ap.status}, want 409`);
    d = await drafts();
    check(d.drf_v5.status === 'waiting_for_owner' && outboxFiles(home).length === before, 'a refused approval changed the draft or the outbox');
    check((await api(f.port, 'POST', `${L}/${encodeURIComponent(LANE)}/on`, { auth: f.token, body: {} })).status === 200, 'switching the lane back on was refused');
  } finally {
    await f.stop();
  }
});
