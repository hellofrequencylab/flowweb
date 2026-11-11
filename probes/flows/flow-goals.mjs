// Probe for FW-C-134 (each flow carries a goal and the number it moves): `pnpm probe flows/flow-goals`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token and a paired browser session), GET /v1/supervisor,
// POST /v1/supervisor/flows/{key}/goal, and draft files the probe writes into
// $FW_HOME/flows/neighborhood-activation/drafts/ before fwd starts (the same files a cycle writes).
//
// The surface this probe expects:
//   POST /v1/supervisor/flows/{key}/goal { metric, target, period, label? } (CLI token or paired session)
//     sets the flow's goal. metric is one of sent, replies, signups, hosts, paid; target a whole number
//     from 1 to 100000; period week (the last 7 days) or month (the last 30 days); label at most 80
//     characters. { target: null } clears the goal. No session 401; unknown flow 404; anything else
//     wrong 400. The goal lives in the Supervisor settings, so it survives a restart of fwd.
//   Every FlowView in GET /v1/supervisor has goal: null, or { metric, target, period, label,
//     progress: { value, as_of } }. value is counted from the flow's own rows (sent: drafts whose sent_at
//     is inside the period; replies: drafts whose replied_at is inside it; signups, hosts and paid: the
//     flow's outcomes.json), never estimated. A metric with no rows to count has value 0, not a guess.
//
// Proves, in order:
//   1. No flow has a goal on a fresh home, and the goal route refuses what it should.
//   2. A replies goal counts only replies inside the period; a sent goal counts sends.
//   3. The goal survives a restart, sits on its own flow only, and clears with target null.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/flow-goals';
const KEY = 'neighborhood-activation';
const OTHER = 'local-saturation';
const S = '/v1/supervisor';
const DAY = 86_400_000;

function seedDrafts(home, now) {
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const iso = (days) => new Date(now - days * DAY).toISOString();
  const drafts = [
    // three replies this week, two sends with no reply this week, one reply from 40 days ago, one waiting
    { id: 'drf_g1', sent_at: iso(3), replied_at: iso(1) },
    { id: 'drf_g2', sent_at: iso(4), replied_at: iso(2) },
    { id: 'drf_g3', sent_at: iso(5), replied_at: iso(2) },
    { id: 'drf_g4', sent_at: iso(2) },
    { id: 'drf_g5', sent_at: iso(6) },
    { id: 'drf_g6', sent_at: iso(45), replied_at: iso(40) },
    { id: 'drf_g7', status: 'waiting_for_owner' },
  ];
  for (const d of drafts) {
    const doc = { status: 'handed_off', created_at: iso(10), body: 'Hello from the probe.', channel: 'email', ...d };
    writeFileSync(join(dir, `${d.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

await probe(NAME, async () => {
  const home = realpathSync(freshHome('flow-goals'));
  seedDrafts(home, Date.now());
  let f = await startFwd(home);
  try {
    const flows = async () => (await api(f.port, 'GET', S, { auth: f.token })).json?.data?.flows ?? [];
    const flowOf = async (key) => (await flows()).find((x) => x.key === key);
    const goal = (key, body, auth = f.token) => api(f.port, 'POST', `${S}/flows/${key}/goal`, { auth, body });

    // ---- 1. no goals yet, and the route's refusals ------------------------------------------------------
    const all = await flows();
    check(all.length > 0, 'GET /v1/supervisor lists no flows');
    if (!all.every((x) => 'goal' in x)) missing('FlowView has no goal field (row FW-C-134)');
    check(all.every((x) => x.goal === null), `a fresh home has goals: ${JSON.stringify(all.map((x) => [x.key, x.goal]))}`);
    const none = await goal(KEY, { metric: 'replies', target: 10, period: 'week' }, null);
    if (none.status === 404 && /no route/i.test(none.text)) missing(`POST ${S}/flows/{key}/goal does not exist (row FW-C-134)`);
    check(none.status === 401, `a goal without a session answered ${none.status}, want 401`);
    check((await goal('no-such-flow', { metric: 'replies', target: 10, period: 'week' })).status === 404, 'a goal on an unknown flow was not 404');
    for (const [body, why] of [
      [{ metric: 'vibes', target: 10, period: 'week' }, 'an unknown metric'],
      [{ metric: 'replies', target: 0, period: 'week' }, 'a target of 0'],
      [{ metric: 'replies', target: 2.5, period: 'week' }, 'a target that is not whole'],
      [{ metric: 'replies', target: 10, period: 'year' }, 'an unknown period'],
      [{ metric: 'replies', target: 10, period: 'week', label: 'x'.repeat(81) }, 'an 81 character label'],
    ]) {
      const r = await goal(KEY, body);
      check(r.status === 400, `${why} answered ${r.status}, want 400`);
    }

    // ---- 2. progress is counted from the flow's rows -----------------------------------------------------
    const { cookie } = await pair(f.port, f.pairingCode);
    const set = await goal(KEY, { metric: 'replies', target: 10, period: 'week', label: 'Ten replies a week' }, { cookie });
    check(set.status === 200, `setting a goal answered ${set.status}: ${set.text.slice(0, 200)}`);
    let g = (await flowOf(KEY))?.goal;
    check(g?.metric === 'replies' && g.target === 10 && g.period === 'week' && g.label === 'Ten replies a week', `the goal reads ${JSON.stringify(g)}`);
    check(g?.progress?.value === 3, `a replies goal counted ${g?.progress?.value}, want 3 (three replies in the last 7 days; one is 40 days old)`);
    check(typeof g?.progress?.as_of === 'string' && !Number.isNaN(Date.parse(g.progress.as_of)), `progress.as_of is ${g?.progress?.as_of}`);
    check((await goal(KEY, { metric: 'replies', target: 10, period: 'month' })).status === 200, 'a month goal was refused');
    g = (await flowOf(KEY))?.goal;
    check(g?.progress?.value === 3, `a month replies goal counted ${g?.progress?.value}, want 3`);
    check((await goal(KEY, { metric: 'sent', target: 20, period: 'week' })).status === 200, 'a sent goal was refused');
    g = (await flowOf(KEY))?.goal;
    check(g?.progress?.value === 5, `a sent goal counted ${g?.progress?.value}, want 5 (five sends in the last 7 days)`);
    check((await goal(OTHER, { metric: 'signups', target: 5, period: 'month' })).status === 200, 'a signups goal was refused');
    const o = (await flowOf(OTHER))?.goal;
    check(o?.progress?.value === 0, `a signups goal with no outcomes counted ${o?.progress?.value}, want 0`);

    // ---- 3. a restart keeps it; clearing removes it ---------------------------------------------------------
    await f.stop();
    f = await startFwd(home);
    g = (await flowOf(KEY))?.goal;
    check(g?.metric === 'sent' && g.target === 20, `after a restart the goal is ${JSON.stringify(g)}`);
    const others = (await flows()).filter((x) => ![KEY, OTHER].includes(x.key));
    check(others.every((x) => x.goal === null), 'setting two goals gave another flow a goal');
    check((await goal(KEY, { target: null })).status === 200, 'clearing the goal was refused');
    check((await flowOf(KEY))?.goal === null, 'target null did not clear the goal');
  } finally {
    await f.stop();
  }
});
