// Probe for FW-C-123 (the Owner meets their agent team): `pnpm probe ui/agent-team`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: packages/daemon/src/team/roles.ts (ROLES) and packages/daemon/src/team/index.ts (teamView), a real
// fwd on a fresh FW_HOME (CLI token and a paired browser session), hosted/server/requests.mjs (pure),
// hosted/relay/fw-relay.mjs (source), hosted/supabase/migrations/0013_flowweb_team.sql, and the Team page packages/web/src/team/TeamPage.tsx (its checks are in
// probes/ui/agent-team.spec.tsx, vitest in jsdom against a fetch stub,
// with routeOf from packages/web/src/shell/routes.ts).
//
// The surface this probe expects (the roster: https://claude.ai/artifact/5GmjmTZb53E7rZUgxLkYf3):
//   ROLES: [{ id, level: ceo | exec | manager | staff | contractor | building, department, title, name,
//     archetype, voice, says, cares_about, judged_on, never, escalates, tier, face, reports_to, flows }].
//     The personality card is name, title and reports_to, archetype, voice and says, cares_about, judged_on,
//     never, escalates, tier and face. Building roles have archetype null. flows names the shipped flows a
//     manager runs.
//   teamView(settings, brands, enabledFlows?) -> { teams: [{ key, brand, label, members: [{ ...role,
//     default_name, default_voice, status: working | bench }] }] }. 'main' first (CEO Kevin), then one per brand.
//   GET /v1/team -> { teams }. POST /v1/team/{team}/{role} { name?, voice? }: string sets, null restores.
//   requestOf: POST /team/{team}/{role} -> team.edit, flow all, payload { team, role, name?, voice? }.
//
// Proves, in order:
//   1. The catalog is the roster: one CEO, six chiefs, fourteen managers each under the chief of its
//      department, eight staff, contractors, the building, one reporting tree, and a full personality card
//      on everyone but the building.
//   2. teamView gives the main team CEO Kevin and Frequency its own CEO, Juniper, The Host.
//   3. A real fwd serves and edits teams: brand teams appear, renames and voices stick, null restores,
//      bad input is refused, and a flow turned on puts its manager and chief to work.
//   4. The site queues team.edit, the relay maps it back and mirrors /team, migration 0013 allows it.
//   5. /team is a page and its checks pass (5 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'ui/agent-team';
const ROLES_FILE = 'packages/daemon/src/team/roles.ts';
const MIGRATION = 'hosted/supabase/migrations/0013_flowweb_team.sql';
const EARLIER = 'hosted/supabase/migrations/0012_flowweb_funnels_switch.sql';
const LEVELS = ['ceo', 'exec', 'manager', 'staff', 'contractor', 'building'];
const CHIEFS = { COO: 'operations', CMO: 'marketing', CRO: 'sales', CCO: 'customers', CFO: 'finance', CTO: 'build' };
const PERSONA = ['name', 'title', 'archetype', 'voice', 'says', 'cares_about', 'judged_on', 'never', 'escalates', 'tier', 'face'];
const DASH = /[–—]/;
const imp = (p) => import(pathToFileURL(join(root, p)).href);

await probe(NAME, async () => {
  // ---- 1. the catalog ----------------------------------------------------------------------------------------
  if (!existsSync(join(root, ROLES_FILE))) missing(`${ROLES_FILE} does not exist (row FW-C-123)`);
  const { ROLES } = await imp(ROLES_FILE);
  check(Array.isArray(ROLES) && ROLES.length > 0, 'roles.ts does not export ROLES');
  const byId = new Map(ROLES.map((r) => [r.id, r]));
  check(byId.size === ROLES.length, 'two roles share an id');
  const of = (level) => ROLES.filter((r) => r.level === level);
  for (const r of ROLES) check(LEVELS.includes(r.level), `role ${r.id} has level ${r.level}`);
  check(of('ceo').length === 1, `there are ${of('ceo').length} CEOs, want 1`);
  const ceo = of('ceo')[0];
  check(ceo.id === 'ceo' && ceo.reports_to === null, `the CEO is ${ceo.id} reporting to ${ceo.reports_to}`);
  check(of('exec').length === 6, `${of('exec').length} chiefs, want 6`);
  for (const [title, dept] of Object.entries(CHIEFS)) {
    const chief = of('exec').filter((r) => r.title.startsWith(title) && r.department === dept);
    check(chief.length === 1 && chief[0].reports_to === ceo.id, `no ${title} for ${dept} reporting to the CEO`);
    const mgrs = of('manager').filter((r) => r.department === dept);
    for (const m of mgrs) check(m.reports_to === chief[0]?.id, `manager ${m.id} reports to ${m.reports_to}, not the ${title}`);
  }
  check(of('manager').length >= 14, `only ${of('manager').length} managers`);
  for (const m of of('manager')) check(Object.values(CHIEFS).includes(m.department), `manager ${m.id} is in ${m.department}`);
  check(of('staff').length >= 8, `only ${of('staff').length} staff`);
  check(of('contractor').length >= 3, `only ${of('contractor').length} contractors`);
  check(of('building').length >= 3, `only ${of('building').length} building roles`);
  const shipped = ['neighborhood-activation', 'local-saturation', 'host-moments', 'local-pulse', 'paid-ads'];
  for (const k of shipped)
    check(of('manager').some((m) => Array.isArray(m.flows) && m.flows.includes(k)), `no manager runs the flow ${k}`);
  for (const [id, name] of [['connector', 'The Connector'], ['editor', 'The Editor'], ['cartographer', 'The Cartographer']])
    check(byId.get(id)?.name === name, `${id} is ${byId.get(id)?.name}, want ${name}`);
  for (const r of of('contractor')) check(!/codex|claude|openai|anthropic|chatgpt/i.test(JSON.stringify(r)), `contractor ${r.id} names a vendor; the kernel is vendor-blind`);
  for (const r of ROLES) {
    if (r === ceo) continue;
    check(byId.has(r.reports_to), `${r.id} reports to unknown ${r.reports_to}`);
    let at = r;
    for (let i = 0; at && at !== ceo && i <= ROLES.length; i++) at = byId.get(at.reports_to);
    check(at === ceo, `${r.id} does not reach the CEO through its reporting line`);
  }
  const people = ROLES.filter((r) => r.level !== 'building');
  for (const r of people)
    for (const f of PERSONA) check(typeof r[f] === 'string' && r[f].trim().length > 1, `${r.id} has no ${f}`);
  for (const r of people) check(['top', 'mid', 'small', 'theirs'].includes(r.tier), `${r.id} has tier ${r.tier}`);
  for (const r of of('building')) check(r.archetype === null && r.tier === 'none', `building role ${r.id} has a personality or a model`);
  for (const f of ['name', 'voice'])
    check(new Set(people.map((r) => r[f])).size === people.length, `two agents share a ${f}`);
  check(!DASH.test(JSON.stringify(ROLES)), 'a role uses an em or en dash');

  // ---- 2. teams ------------------------------------------------------------------------------------------------
  const { teamView } = await imp('packages/daemon/src/team/index.ts');
  check(typeof teamView === 'function', 'team/index.ts does not export teamView');
  const tv = teamView({}, ['Frequency']);
  check(tv?.teams?.[0]?.key === 'main', `the first team is ${tv?.teams?.[0]?.key}, want main`);
  const ceoOf = (t) => t?.members?.find((m) => m.level === 'ceo');
  check(ceoOf(tv.teams[0])?.name === 'Kevin', `the main CEO is ${ceoOf(tv.teams[0])?.name}, want Kevin`);
  const fq = tv.teams.find((t) => t.key === 'frequency');
  check(fq?.brand === 'Frequency', `no Frequency team: ${JSON.stringify(tv.teams.map((t) => t.key))}`);
  check(ceoOf(fq)?.name === 'Juniper', `Frequency's CEO is ${ceoOf(fq)?.name}, want Juniper`);
  check(/^The Host\b/.test(ceoOf(fq)?.archetype ?? ''), `Juniper's archetype is ${ceoOf(fq)?.archetype}, want The Host`);
  check(ceoOf(fq)?.voice !== ceoOf(tv.teams[0])?.voice, "Juniper has Kevin's voice");
  check(fq.members.length === ROLES.length, `the Frequency team has ${fq.members.length} members`);

  // ---- 3. a real fwd -------------------------------------------------------------------------------------------
  const f = await startFwd(realpathSync(freshHome('agent-team')), { env: { FW_VENDOR: 'fake' } });
  try {
    const teams = async () => {
      const g = await api(f.port, 'GET', '/v1/team', { auth: f.token });
      check(g.status === 200, `GET /v1/team answered ${g.status}: ${g.text.slice(0, 200)}`);
      return g.json?.data?.teams ?? [];
    };
    const member = (ts, team, id) => ts.find((t) => t.key === team)?.members?.find((m) => m.id === id);
    let ts = await teams();
    check(ts[0]?.key === 'main' && ceoOf(ts[0])?.name === 'Kevin', `fwd's main team is ${JSON.stringify(ts[0]?.key)}`);
    const st = (t, id) => t.members.find((m) => m.id === id)?.status;
    const coo = ts[0].members.find((m) => m.level === 'exec' && m.department === 'operations')?.id;
    const cmo = ts[0].members.find((m) => m.level === 'exec' && m.department === 'marketing')?.id;
    const cfo = ts[0].members.find((m) => m.level === 'exec' && m.department === 'finance')?.id;
    check(st(ts[0], ceo.id) === 'working' && st(ts[0], coo) === 'working', 'the CEO or the COO is on the bench');
    check(st(ts[0], 'connector') === 'bench' && st(ts[0], cmo) === 'bench', `with no flow on the Connector is ${st(ts[0], 'connector')} and the CMO ${st(ts[0], cmo)}`);

    const made = await api(f.port, 'POST', '/v1/projects', { auth: f.token, body: { slug: 'team-probe', name: 'Team probe' } });
    check(made.status === 200, `making a project answered ${made.status}: ${made.text.slice(0, 200)}`);
    const id = (await api(f.port, 'GET', '/v1/projects', { auth: f.token })).json?.data?.[0]?.id;
    const lab = await api(f.port, 'POST', `/v1/projects/${encodeURIComponent(id)}/labels`, { auth: f.token, body: { brand: 'Frequency' } });
    check(lab.status === 200, `labelling the project answered ${lab.status}: ${lab.text.slice(0, 200)}`);
    ts = await teams();
    check(ts.some((t) => t.key === 'frequency'), `labelling a project Frequency added no team: ${ts.map((t) => t.key)}`);
    const fceo = ceoOf(ts.find((t) => t.key === 'frequency'));

    const T = `/v1/team/frequency/${fceo.id}`;
    const none = await api(f.port, 'POST', T, { body: { name: 'Nova' } });
    check(none.status === 401, `no session answered ${none.status}, want 401`);
    const { cookie } = await pair(f.port, f.pairingCode);
    const ren = await api(f.port, 'POST', T, { auth: { cookie }, body: { name: 'Nova', voice: 'Bright and quick.' } });
    check(ren.status === 200, `renaming answered ${ren.status}: ${ren.text.slice(0, 200)}`);
    ts = await teams();
    const nova = member(ts, 'frequency', fceo.id);
    check(nova?.name === 'Nova' && nova?.default_name === fceo.name, `after renaming the CEO is ${JSON.stringify(nova?.name)}`);
    check(nova?.voice === 'Bright and quick.' && nova?.default_voice === fceo.voice, 'the new voice did not stick');
    check(ceoOf(ts[0])?.name === 'Kevin', 'renaming the Frequency CEO renamed Kevin');
    const back = await api(f.port, 'POST', T, { auth: f.token, body: { name: null } });
    check(back.status === 200, `restoring answered ${back.status}`);
    ts = await teams();
    check(member(ts, 'frequency', fceo.id)?.name === fceo.name, 'null did not restore the default name');
    check(member(ts, 'frequency', fceo.id)?.voice === 'Bright and quick.', 'restoring the name dropped the voice');
    const bld = ROLES.find((r) => r.level === 'building');
    const tries = [
      [`/v1/team/nobody/${fceo.id}`, { name: 'X' }, 404],
      ['/v1/team/main/no-such-role', { name: 'X' }, 404],
      [`/v1/team/main/${bld.id}`, { name: 'X' }, 400],
      [T, { name: 'x'.repeat(41) }, 400],
      [T, { name: 7 }, 400],
      [T, {}, 400],
    ];
    for (const [p, body, want] of tries) {
      const r = await api(f.port, 'POST', p, { auth: f.token, body });
      check(r.status === want, `POST ${p} ${JSON.stringify(body).slice(0, 40)} answered ${r.status}, want ${want}`);
    }

    const flows = (await api(f.port, 'GET', '/v1/supervisor', { auth: f.token })).json?.data?.flows ?? [];
    const key = 'neighborhood-activation';
    check(flows.some((x) => x.key === key), `fwd does not list ${key}`);
    const on = await api(f.port, 'POST', `/v1/supervisor/flows/${key}/enable`, { auth: f.token });
    check(on.status === 200, `turning ${key} on answered ${on.status}: ${on.text.slice(0, 200)}`);
    ts = await teams();
    check(st(ts[0], 'connector') === 'working' && st(ts[0], cmo) === 'working', `with ${key} on the Connector is ${st(ts[0], 'connector')} and the CMO ${st(ts[0], cmo)}`);
    check(st(ts[0], 'mentor') === 'bench' && st(ts[0], cfo) === 'bench', 'turning on one flow woke an unrelated manager or chief');
    check(st(ts.find((t) => t.key === 'frequency'), 'connector') === 'working', "the Frequency team's Connector is not working");
  } finally {
    await f.stop();
  }

  // ---- 4. the site queue, the relay and migration 0013 -------------------------------------------------------
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const P = '/team/frequency/ceo';
  for (const body of [{ name: 'Nova' }, { voice: 'Calm.' }, { name: null, voice: 'Calm.' }]) {
    const r = requestOf('POST', P, { ...body, extra: 'dropped' });
    check(r && !r.error && r.kind === 'team.edit' && r.flow === 'all', `POST ${P} became ${JSON.stringify(r)}`);
    const want = JSON.stringify({ team: 'frequency', role: 'ceo', ...body });
    check(JSON.stringify(r.payload) === want, `team.edit carries ${JSON.stringify(r.payload)}, want ${want}`);
    const call = fwdCallFor({ id: 'r1', ...r });
    check(call?.method === 'POST' && call.path === P && JSON.stringify(call.body) === JSON.stringify(body), `the relay calls ${JSON.stringify(call)}`);
  }
  check(requestOf('POST', P, {})?.error, 'an empty change was queued');
  check(requestOf('POST', P, { name: 'x'.repeat(41) })?.error, 'a long name was queued');
  check(requestOf('POST', '/team/Bad Team/ceo', { name: 'X' })?.error ?? requestOf('POST', '/team/Bad Team/ceo', { name: 'X' }) === null, 'a bad team key was queued');
  check(fwdCallFor({ id: 'r2', kind: 'team.edit', flow: 'all', payload: { team: 'main', role: 'ceo' } }) === null, 'the relay would apply an empty change');
  const relay = readFileSync(join(root, 'hosted/relay/fw-relay.mjs'), 'utf8');
  check(/['"`]\/team['"`]/.test(relay), 'the relay does not mirror /team');
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-123)`);
  const sql = readFileSync(mig, 'utf8');
  const earlier = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  check(earlier.length >= 20, `read only ${earlier.length} kinds from ${EARLIER}`);
  for (const k of [...new Set([...earlier, 'team.edit', 'flow.copy'])]) check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);
  check(/drop constraint if exists fw_requests_kind_check/.test(sql), `${MIGRATION} does not replace fw_requests_kind_check`);

  // ---- 5. the Team page --------------------------------------------------------------------------------------
  if (!existsSync(join(root, 'packages/web/src/team/TeamPage.tsx'))) missing('packages/web/src/team/TeamPage.tsx does not exist');
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('agent-team'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/agent-team.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const out = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfgFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const failed = text.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(out.status === 0, `the Team page checks failed (exit ${out.status}):\n${failed.join('\n') || text.slice(-800)}`);
  check(/Tests\s+5 passed/.test(text), `expected 5 Team page checks to pass:\n${text.slice(-400)}`);
});
