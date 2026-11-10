// Probe for FW-C-032 (neighborhood activation flow): `pnpm probe flows/neighborhood-activation`. Tier 0.
// Surfaces: the shipped definition in flows/neighborhood-activation/, the daemon fwd (started as one
// node process on a fresh FW_HOME), and GET /v1/flows/neighborhood-activation with the CLI token fwd
// prints. State is written to $FW_HOME/flows/neighborhood-activation/state.json between reads.
//
// Proves, in order:
//   1. stream.json and config.json exist. The stream starts disabled at tier L1 (draft only), its
//      human gate is the Owner, every lead source's action class is gated, and it has a dollar cap.
//      Territories are large regions, each with sub-areas. The seed is North County San Diego, and
//      every border names a territory in the list.
//   2. A fresh fwd serves the flow: the seed is active and every other territory waits. With no
//      Frequency data the seed's measures and progress are null (unknown), never zero. The next move
//      is keep_working and the budget shows the stream's caps.
//   3. With the seed meeting every target for hold_weeks, the next move proposes exactly one
//      territory: the bordering, unopened one first in the Owner's order. The opened list is still
//      the seed alone.
//   4. Leads are routed: a high-fit, high-timing host in the seed is invited to the practitioner
//      funnel as a personal founder email, and its link carries persona, region, sub-area, Channel
//      and source; a host in a waiting territory is watched; a lead on the do-not-contact list is
//      blocked; a lead with max touches in the last 30 days is capped; a resident gets no personal
//      message (post_only), points at /start/event and goes through Frequency.
//   5. With the period's dollar cap used up, the next move is paused_budget.
//   6. An unknown flow key answers 404.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  check,
  DAEMON_BIN,
  freshHome,
  killAndWait,
  missing,
  probe,
  requireFile,
  root,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/neighborhood-activation';
const KEY = 'neighborhood-activation';
const kids = [];

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function httpGet(port, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${token}` }, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => ok({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    req.end();
  });
}

async function startFwd(home) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

async function view(f) {
  const r = await httpGet(f.port, `/v1/flows/${KEY}`, f.token);
  if (r.status === 404) missing(`GET /v1/flows/${KEY} answered 404 (flow not served)`);
  check(r.status === 200, `GET /v1/flows/${KEY} answered ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body).data;
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

await probe(NAME, async () => {
  // ---- 1. shipped definition ---------------------------------------------------------------
  requireFile(`flows/${KEY}/stream.json`, 'the flow stream definition');
  requireFile(`flows/${KEY}/config.json`, 'the flow config: territories, activation targets, lead rules, funnels');
  const stream = JSON.parse(readFileSync(join(root, `flows/${KEY}/stream.json`), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(root, `flows/${KEY}/config.json`), 'utf8'));
  check(stream.key === KEY, `stream.json key is ${stream.key}, want ${KEY}`);
  check(stream.enabled === false, 'stream.json must ship disabled');
  check(stream.default_tier === 'L1', `stream.json default_tier is ${stream.default_tier}, want L1 (draft only)`);
  check(stream.human_gate?.approver === 'owner', 'stream.json human_gate.approver is not owner');
  for (const s of cfg.sources ?? [])
    if (s.action_class !== 'read_research')
      check(
        (stream.human_gate.gate_on ?? []).includes(s.action_class),
        `lead source ${s.key} uses ${s.action_class}, which the human gate does not cover`,
      );
  check(stream.budget?.caps?.max_usd > 0, 'stream.json has no dollar cap');
  check(cfg.seed_territory_id === 'north-county-sd', `seed territory is ${cfg.seed_territory_id}, want north-county-sd`);
  const ids = new Set(cfg.territories.map((t) => t.id));
  for (const t of cfg.territories) {
    check(Array.isArray(t.sub_areas) && t.sub_areas.length > 1, `territory ${t.id} is not a large region with sub-areas`);
    for (const b of t.borders) check(ids.has(b), `territory ${t.id} borders ${b}, which is not in the list`);
  }
  const seed = cfg.seed_territory_id;
  const seedT = cfg.territories.find((t) => t.id === seed);
  const seedBorders = new Set(seedT.borders);
  for (const t of cfg.territories) if (t.borders.includes(seed)) seedBorders.add(t.id);
  const firstNext = cfg.territories
    .filter((t) => seedBorders.has(t.id))
    .sort((x, y) => x.order - y.order)[0]?.id;

  const home = freshHome('flow-na');
  try {
    // ---- 2. fresh fwd -------------------------------------------------------------------------
    const f = await startFwd(home);
    let v = await view(f);
    const ter = (id) => v.territories.find((t) => t.id === id);
    check(ter(seed)?.status === 'active', `seed status is ${ter(seed)?.status}, want active`);
    check(
      v.territories.filter((t) => t.id !== seed).every((t) => t.status === 'waiting'),
      'a fresh flow must have every territory but the seed waiting',
    );
    check(ter(seed).measures === null && ter(seed).progress === null, 'with no Frequency data the seed must read unknown (null), not zero');
    check(v.decision?.kind === 'keep_working', `fresh decision is ${v.decision?.kind}, want keep_working`);
    check(v.budget?.max_usd === stream.budget.caps.max_usd, 'budget.max_usd does not match the stream cap');

    // ---- 3. qualified seed proposes one bordering territory -----------------------------------
    const dir = join(home, 'flows', KEY);
    mkdirSync(dir, { recursive: true });
    // Far above any target, so the seed qualifies whatever the scaling.
    const met = {
      hosts_active_28d: 1_000_000,
      events_next_14d: 1_000_000,
      sub_areas_covered_14d: seedT.sub_areas.length,
      wam: 100_000_000,
    };
    const spend0 = { period_start: new Date().toISOString(), usd: 0, turns: 0 };
    const waiting = [...seedBorders][0];
    const base = {
      opened: [seed],
      metrics: { [seed]: met },
      weeks_at_threshold: { [seed]: a.hold_weeks },
      weeks_below: {},
      awaiting_owner: {},
      do_not_contact: ['lead-dnc'],
      leads: [
        { id: 'lead-host', name: 'Host A', kind: 'host', territory_id: seed, sub_area: 'leucadia', channel: 'movement', source: 'event_listings', url: 'https://example.com/a', fit: 0.9, timing: 0.9, timing_at: daysAgo(1), touches: [], found_at: daysAgo(2) },
        { id: 'lead-far', name: 'Host B', kind: 'host', territory_id: waiting, source: 'event_listings', url: 'https://example.com/b', fit: 0.9, timing: 0.9, timing_at: daysAgo(1), touches: [], found_at: daysAgo(2) },
        { id: 'lead-dnc', name: 'Host C', kind: 'host', territory_id: seed, source: 'event_listings', url: 'https://example.com/c', fit: 0.9, timing: 0.9, timing_at: daysAgo(1), touches: [], found_at: daysAgo(2) },
        { id: 'lead-cap', name: 'Venue D', kind: 'venue', territory_id: seed, source: 'business_listings', url: 'https://example.com/d', fit: 0.9, timing: 0.9, timing_at: daysAgo(1), touches: Array.from({ length: cfg.leads.max_touches_per_lead_30d }, (_, i) => daysAgo(3 + i)), found_at: daysAgo(20) },
        { id: 'lead-res', name: 'Resident E', kind: 'resident', territory_id: seed, source: 'local_groups', url: 'https://example.com/e', fit: 0.9, timing: 0.9, timing_at: daysAgo(1), touches: [], found_at: daysAgo(2) },
      ],
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...base, spend: spend0 }));
    v = await view(f);
    check(v.decision?.kind === 'propose_expansion', `qualified seed decision is ${v.decision?.kind}, want propose_expansion`);
    const pick = v.decision.territory_id;
    check(pick === firstNext, `the proposal names ${pick}, want ${firstNext} (bordering, first in the Owner's order)`);
    check(JSON.stringify(v.opened) === JSON.stringify([seed]), 'the flow opened a territory by itself');
    check(ter(seed).progress >= 1 && ter(seed).qualifies === true, 'a seed meeting every target must show progress 1 and qualify');

    // ---- 4. lead routing ----------------------------------------------------------------------
    const lead = (id) => v.leads.find((l) => l.id === id);
    check(lead('lead-host')?.stage === 'invite', `host in the seed is ${lead('lead-host')?.stage}, want invite`);
    check(lead('lead-host').funnel?.persona === 'practitioner', 'a host must route to the practitioner persona');
    check(lead('lead-host').send_via === 'founder_email', `a host invite goes via ${lead('lead-host').send_via}, want founder_email`);
    const link = new URL(lead('lead-host').funnel.url);
    for (const [k, want] of [['persona', 'practitioner'], ['region', seed], ['area', 'leucadia'], ['channel', 'movement'], ['src', 'event_listings']])
      check(link.searchParams.get(k) === want, `the host funnel link has ${k}=${link.searchParams.get(k)}, want ${want}`);
    check(lead('lead-far')?.stage === 'watch', `host in a waiting territory is ${lead('lead-far')?.stage}, want watch`);
    check(lead('lead-dnc')?.stage === 'blocked', `do-not-contact lead is ${lead('lead-dnc')?.stage}, want blocked`);
    check(lead('lead-cap')?.stage === 'capped', `lead at the touch cap is ${lead('lead-cap')?.stage}, want capped`);
    check(lead('lead-res')?.stage === 'post_only', `resident is ${lead('lead-res')?.stage}, want post_only`);
    check(lead('lead-res').funnel?.path === '/start/event', 'a resident must point at /start/event');
    check(lead('lead-res').send_via === 'frequency', `a resident goes via ${lead('lead-res').send_via}, want frequency`);

    // ---- 5. cap used up pauses -----------------------------------------------------------------
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...base, spend: { ...spend0, usd: stream.budget.caps.max_usd } }));
    v = await view(f);
    check(v.decision?.kind === 'paused_budget', `decision with the cap used up is ${v.decision?.kind}, want paused_budget`);

    // ---- 6. unknown key -----------------------------------------------------------------------
    const r = await httpGet(f.port, '/v1/flows/not-a-flow', f.token);
    check(r.status === 404, `GET /v1/flows/not-a-flow answered ${r.status}, want 404`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
