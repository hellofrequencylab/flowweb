// Probe for FW-C-063 (when a flow runs each morning and how many people it reaches a day): `pnpm probe flows/morning-intensity`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: packages/daemon/src/overseer/intensity.ts (pure: scheduleCron and effectivePerDay),
// packages/daemon/src/flows/hunts.ts (screenLeads with perDay), hosted/server/requests.mjs (pure),
// hosted/supabase/migrations/0005_flowweb_morning_intensity.sql, a real fwd on a fresh FW_HOME with a
// paired browser session (cookie), and packages/web's FlowControls (its checks are in
// probes/flows/morning-intensity.spec.tsx, run with vitest in jsdom against a fetch stub, as
// probes/flows/site-controls.mjs does).
//
// The surface this probe expects:
//   scheduleCron(time 'HH:MM', days 'daily' | 'weekdays') -> 'M H * * *' | 'M H * * 1-5'; throws otherwise.
//   effectivePerDay({ per_day, auto, min, max }, { sent, responded, declined }) -> { per_day, why }
//     auto off: per_day. auto on and sent < 20: per_day. declined/sent >= 10%: half. responded/sent >= 8%:
//     one and a half. responded/sent < 2%: three quarters. Rounded, then held within min..max. why is text.
//   screenLeads({ ..., perDay }) keeps at most perDay new people counting hunt_contacts from the last 20 hours.
//   POST /v1/supervisor/flows/{key}/schedule { time, days } and .../intensity { per_day, auto, min, max }
//     answer the CLI token and the paired browser session; GET /v1/supervisor shows, per flow,
//     schedule { time, days, cron, timezone } and intensity { per_day, auto, min, max, today: { per_day, why } }.
//   requestOf: POST .../schedule -> flow.schedule, POST .../intensity -> flow.intensity; fwdCallFor maps back.
//
// Proves, in order:
//   1. scheduleCron builds the cron for a morning time on every day and on weekdays, and refuses bad input.
//   2. effectivePerDay keeps, halves, raises and lowers the number as above, never outside min..max.
//   3. screenLeads stops at perDay new people a day, counting people drafted for in the last 20 hours.
//   4. With a paired browser session: the schedule changes the flow's stream cron (GET /v1/supervisor) and
//      records stream.updated; the intensity shows with today's number; bad values answer 400; no
//      session answers 401.
//   5. The site queues flow.schedule and flow.intensity, the relay calls the same route with the same body,
//      and migration 0005 allows both kinds and every kind 0004 allowed.
//   6. The FlowControls checks pass: save a morning time and days, save a leads-per-day number with
//      Adjust from replies, and show today's number and why.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/morning-intensity';
const KEY = 'neighborhood-activation';
const MIGRATION = 'hosted/supabase/migrations/0005_flowweb_morning_intensity.sql';
const EARLIER = 'hosted/supabase/migrations/0004_flowweb_flow_controls.sql';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const flowOf = (sup) => (sup?.flows ?? []).find((f) => f.key === KEY);

await probe(NAME, async () => {
  // 1. scheduleCron.
  const intensityFile = 'packages/daemon/src/overseer/intensity.ts';
  if (!existsSync(join(root, intensityFile))) missing(`${intensityFile} does not exist (row FW-C-063)`);
  const { scheduleCron, effectivePerDay } = await imp(intensityFile);
  if (typeof scheduleCron !== 'function' || typeof effectivePerDay !== 'function')
    missing(`${intensityFile} does not export scheduleCron and effectivePerDay (row FW-C-063)`);
  check(scheduleCron('06:00', 'daily') === '0 6 * * *', `06:00 daily gave ${scheduleCron('06:00', 'daily')}`);
  check(scheduleCron('05:30', 'weekdays') === '30 5 * * 1-5', `05:30 weekdays gave ${scheduleCron('05:30', 'weekdays')}`);
  for (const [t, d] of [['25:00', 'daily'], ['6', 'daily'], ['06:00', 'sometimes'], ['06:60', 'weekdays']]) {
    let threw = false;
    try {
      scheduleCron(t, d);
    } catch {
      threw = true;
    }
    check(threw, `scheduleCron(${t}, ${d}) should refuse`);
  }

  // 2. effectivePerDay.
  const set = { per_day: 10, auto: true, min: 4, max: 14 };
  const day = (s, stats) => effectivePerDay(s, stats);
  const cases = [
    [{ ...set, auto: false }, { sent: 100, responded: 30, declined: 0 }, 10, 'auto off keeps the number'],
    [set, { sent: 19, responded: 10, declined: 0 }, 10, 'too few sent keeps the number'],
    [set, { sent: 40, responded: 1, declined: 4 }, 5, '10% declined halves it'],
    [set, { sent: 40, responded: 4, declined: 0 }, 14, '10% responded raises it by half, held at max'],
    [{ ...set, max: 25 }, { sent: 40, responded: 4, declined: 0 }, 15, '10% responded raises it by half'],
    [set, { sent: 60, responded: 0, declined: 0 }, 8, 'nothing back lowers it by a quarter'],
    [{ ...set, per_day: 4 }, { sent: 40, responded: 0, declined: 10 }, 4, 'never below min'],
    [set, { sent: 40, responded: 2, declined: 1 }, 10, 'middling results keep the number'],
  ];
  for (const [s, stats, want, what] of cases) {
    const out = day(s, stats);
    check(out?.per_day === want, `${what}: got ${out?.per_day}, want ${want}`);
    check(typeof out?.why === 'string' && out.why.length > 0, `${what}: no reason given`);
  }

  // 3. screenLeads with perDay.
  const { screenLeads } = await imp('packages/daemon/src/flows/hunts.ts');
  const now = new Date('2026-11-11T14:00:00Z');
  const cfg = { leads: { max_new_invites_per_week: 50 }, hunts: { sign_off: 'Probe' }, offer: { url: 'https://example.org' }, funnels: { host: { path: '/start/host', persona: 'practitioner' } } };
  const hunt = { id: 'hnt_probe1', name: 'Probe', looking_for: 'x', region: 'r', areas: [], links: [], every_days: 1, max_sends: 10, build: false, enabled: true, created_at: now.toISOString(), last_run_at: null };
  const lead = (i) => ({
    hunt_id: hunt.id,
    event: { title: `Event ${i}`, starts_at: null, url: `https://example.org/e/${i}`, country: 'US' },
    organizer: { name: `Org ${i}`, email: `org${i}@example.org`, source_url: `https://example.org/o/${i}`, country: 'US', contact_via: 'email', contact_url: null },
    subject: 'Hello',
    body: 'Hi there',
  });
  const leads = [1, 2, 3, 4, 5].map(lead);
  const state = (contacts) => ({ do_not_contact: [], hunt_contacts: contacts });
  const a = screenLeads({ cfg, state: state({}), hunts: [hunt], leads, now, perDay: 3 });
  check(a.kept.length === 3, `perDay 3 with no one today kept ${a.kept.length}, want 3`);
  const old = new Date(now.getTime() - 22 * 3600e3).toISOString();
  const recent = new Date(now.getTime() - 2 * 3600e3).toISOString();
  const b = screenLeads({
    cfg,
    state: state({
      'a@example.net': { at: recent, hunt_id: hunt.id, event_url: 'https://example.net/1' },
      'b@example.net': { at: recent, hunt_id: hunt.id, event_url: 'https://example.net/2' },
      'c@example.net': { at: old, hunt_id: hunt.id, event_url: 'https://example.net/3' },
    }),
    hunts: [hunt],
    leads,
    now,
    perDay: 3,
  });
  check(b.kept.length === 1, `perDay 3 with 2 drafted in the last 20 hours kept ${b.kept.length}, want 1`);
  const c = screenLeads({ cfg, state: state({}), hunts: [hunt], leads, now });
  check(c.kept.length === 5, `without perDay the existing caps keep ${c.kept.length}, want 5`);

  // 4. A real fwd and its paired browser session.
  const S = `/supervisor/flows/${KEY}`;
  const home = freshHome('morning-intensity');
  const fwd = await startFwd(home, { env: { FW_VENDOR: 'fake' } });
  try {
    const sup = async () => (await api(fwd.port, 'GET', '/v1/supervisor', { auth: fwd.token })).json?.data;
    const none = await api(fwd.port, 'POST', `/v1${S}/schedule`, { body: { time: '06:00', days: 'daily' } });
    check(none.status === 401, `schedule without a session or token answered ${none.status}, want 401`);
    const { cookie } = await pair(fwd.port, fwd.pairingCode);
    const on = await api(fwd.port, 'POST', `/v1${S}/enable`, { auth: { cookie }, body: {} });
    check(on.status === 200, `enable answered ${on.status}: ${on.text.slice(0, 200)}`);
    const sch = await api(fwd.port, 'POST', `/v1${S}/schedule`, { auth: { cookie }, body: { time: '06:15', days: 'daily' } });
    check(sch.status === 200, `schedule answered ${sch.status}: ${sch.text.slice(0, 200)}`);
    const f = flowOf(await sup());
    check(f?.schedule?.cron === '15 6 * * *', `after the schedule the flow's cron is ${f?.schedule?.cron}, want 15 6 * * *`);
    check(f?.schedule?.time === '06:15' && f?.schedule?.days === 'daily', `schedule shows ${JSON.stringify(f?.schedule)}`);
    check(typeof f?.schedule?.timezone === 'string' && f.schedule.timezone.length > 0, 'schedule has no timezone');
    const ev = await api(fwd.port, 'GET', '/v1/events?type=stream.updated', { auth: fwd.token });
    check((ev.json?.data ?? []).length >= 1, 'changing the schedule recorded no stream.updated event');
    const bad = await api(fwd.port, 'POST', `/v1${S}/schedule`, { auth: { cookie }, body: { time: '26:00', days: 'daily' } });
    check(bad.status === 400, `a bad time answered ${bad.status}, want 400`);
    const int = await api(fwd.port, 'POST', `/v1${S}/intensity`, {
      auth: { cookie },
      body: { per_day: 12, auto: true, min: 5, max: 20 },
    });
    check(int.status === 200, `intensity answered ${int.status}: ${int.text.slice(0, 200)}`);
    const g = flowOf(await sup());
    const i = g?.intensity;
    check(i?.per_day === 12 && i?.auto === true && i?.min === 5 && i?.max === 20, `intensity shows ${JSON.stringify(i)}`);
    check(i?.today?.per_day === 12 && typeof i?.today?.why === 'string', `a fresh flow's today is ${JSON.stringify(i?.today)}, want 12 with a reason`);
    for (const body of [{ per_day: 0, auto: false, min: 1, max: 25 }, { per_day: 30, auto: false, min: 1, max: 25 }, { per_day: 10, auto: true, min: 12, max: 20 }]) {
      const r = await api(fwd.port, 'POST', `/v1${S}/intensity`, { auth: { cookie }, body });
      check(r.status === 400, `intensity ${JSON.stringify(body)} answered ${r.status}, want 400`);
    }
  } finally {
    await fwd.stop();
  }

  // 5. The site queue and migration 0005.
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const P = `/supervisor/flows/${KEY}`;
  const site = [
    [`${P}/schedule`, { time: '05:45', days: 'weekdays', extra: 1 }, 'flow.schedule', { time: '05:45', days: 'weekdays' }],
    [`${P}/intensity`, { per_day: 8, auto: true, min: 3, max: 15 }, 'flow.intensity', { per_day: 8, auto: true, min: 3, max: 15 }],
  ];
  for (const [path, body, kind, payload] of site) {
    const r = requestOf('POST', path, body);
    check(r && !r.error, `POST ${path} did not become a request: ${JSON.stringify(r)}`);
    check(r.kind === kind && r.flow === KEY, `POST ${path} became ${r.kind} for ${r.flow}, want ${kind} for ${KEY}`);
    check(JSON.stringify(r.payload) === JSON.stringify(payload), `POST ${path} carries ${JSON.stringify(r.payload)}`);
    const call = fwdCallFor({ id: 'r1', ...r });
    check(call?.method === 'POST' && call.path === path, `${kind}: relay calls ${call?.method} ${call?.path}`);
    check(JSON.stringify(call.body) === JSON.stringify(payload), `${kind}: relay sends ${JSON.stringify(call.body)}`);
  }
  for (const [path, body] of [
    [`${P}/schedule`, { time: '29:00', days: 'daily' }],
    [`${P}/schedule`, { time: '06:00', days: 'sometimes' }],
    [`${P}/intensity`, { per_day: 99, auto: false, min: 1, max: 25 }],
  ]) {
    const r = requestOf('POST', path, body);
    check(r?.error, `POST ${path} ${JSON.stringify(body)} should be refused, got ${JSON.stringify(r)}`);
  }
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-063)`);
  const sql = readFileSync(mig, 'utf8');
  const before = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'((?:draft|flow|supervisor|hunt)\.[a-z]+)'/g)].map((m) => m[1]);
  for (const k of [...new Set([...before, 'flow.schedule', 'flow.intensity'])])
    check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);

  // 6. The Flows page controls.
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('morning-intensity'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/morning-intensity.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the morning and intensity controls failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+3 passed/.test(out), `expected 3 morning and intensity checks to pass:\n${out.slice(-400)}`);
});
