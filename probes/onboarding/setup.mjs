// Probe for FW-C-038 (a new Owner gets set up with one guided command): `pnpm probe onboarding/setup`.
// Tier 0.
// probe-timeout-s: 300
// Surfaces: the fw CLI (`fw setup`, `fw project add`, `fw project label`, `fw project brief`,
// `fw supervisor enable`, `fw ledger sync`) on a fresh FW_HOME, the daemon fwd started as one node
// process on a free port, GET /v1/setup on that fwd, and two files other tools write into the home:
// accounts-check.json (written by `fw accounts check`) and relay-last-push.json (written by the relay
// after the live site accepts a push).
// The surface this probe expects:
//   fw setup --json -> { ready, next, fwd: "up"|"down", steps: [{ id, title, required, done, detail, fix }] }
//   Step ids, in order: machine, sign_ins, project, brief, flow, live_site. live_site is optional
//   (required false); the rest are required. ready is true when every required step is done; next
//   is the first required step not done, or null. A step not done has a fix: the command or place
//   that does it. Exit 0 when ready, 1 when not. GET /v1/setup answers the same report.
//   fw project add <slug> --name <n> [--kind <k>] [--brand <b>] [--category <c>] creates a project
//   with no repository; a slug already taken is refused and nothing is created.
//   fw project brief <project> --what --who --voice --never --done saves the Owner's five answers
//   word for word; a missing or blank answer exits 2 and saves nothing; with no answers it prints
//   the saved brief.
//   Every project write works while fwd is running (fwd holds the database writer).
//
// Proves, in order:
//   1. On an empty home with no fwd, setup is not ready, next is machine, every step not done has a
//      fix, and machine's fix says how to start fwd.
//   2. With fwd running, machine is done and next is sign_ins, whose fix names fw accounts connect.
//   3. sign_ins counts only a passing test call: a failed check leaves it not done; a passing one
//      ticks it.
//   4. With fwd running, fw project add creates a project with no repository; the same slug again is
//      refused. A project with a brand but no category does not tick project; adding the category
//      does.
//   5. A brief with a missing or blank answer is refused and saves nothing; a full brief ticks brief,
//      and reads back word for word.
//   6. Enabling a flow ticks flow. setup is then ready (exit 0, next null) while the optional
//      live_site step is still not done, and its fix points at Add a machine.
//   7. A recent accepted push ticks live_site; an old one does not.
//   8. GET /v1/setup answers the same steps; no secret from the home appears in either answer.
//   9. With fwd stopped again, setup says fwd is down and machine is not done.
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  check,
  DAEMON_BIN,
  fakeSecret,
  fixtureProject,
  freshHome,
  fw,
  killAndWait,
  missing,
  probe,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'onboarding/setup';
const STEPS = ['machine', 'sign_ins', 'project', 'brief', 'flow', 'live_site'];
const FLOW = 'local-saturation';
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

function get(port, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${token}` }, timeout: 5000 },
      (res) => {
        let text = '';
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => ok({ status: res.statusCode, body: text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    req.end();
  });
}

async function startFwd(home, port) {
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, token: readFileSync(tokenPath, 'utf8').trim() };
}

function parse(r, what) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    check(false, `${what} did not print one JSON document (exit ${r.status}): ${(r.stdout || r.stderr).slice(0, 200)}`);
  }
}

function accountsReport(ok) {
  return {
    checked_at: new Date().toISOString(),
    accounts: [
      {
        id: 'claude_signin',
        label: 'Claude sign-in',
        handle: 'crd_claude0002',
        set_up: true,
        ok,
        detail: ok ? 'answered OK' : 'the test call was refused (401)',
        ...(ok ? {} : { fix: 'pnpm fw accounts connect --only claude' }),
      },
    ],
    fwd_env: { FW_CLAUDE_AUTH: ok ? 'signin' : null, FW_CODEX_AUTH: null },
    start_command: ok ? 'FW_CLAUDE_AUTH=signin pnpm fwd' : null,
  };
}

await probe(NAME, async () => {
  const home = freshHome('setup');
  const port = await freePort();
  const env = { FW_PORT: String(port) };
  const setup = (what) => {
    const r = fw(['setup', '--json'], { home, env });
    if (/unknown command|no such command/i.test(`${r.stdout}${r.stderr}`)) missing('fw setup does not exist');
    const s = parse(r, `fw setup --json (${what})`);
    check(Array.isArray(s.steps), `fw setup --json (${what}) has no steps array`);
    check(
      JSON.stringify(s.steps.map((x) => x.id)) === JSON.stringify(STEPS),
      `setup steps are ${s.steps.map((x) => x.id).join(', ')}; want ${STEPS.join(', ')}`,
    );
    for (const x of s.steps) {
      check(typeof x.title === 'string' && x.title, `step ${x.id} has no title`);
      check(typeof x.detail === 'string', `step ${x.id} has no detail`);
      check(x.required === (x.id !== 'live_site'), `step ${x.id} required is ${x.required}`);
      if (!x.done) check(typeof x.fix === 'string' && x.fix.trim(), `step ${x.id} is not done and has no fix`);
    }
    const firstOpen = s.steps.find((x) => x.required && !x.done)?.id ?? null;
    check(s.next === firstOpen, `next is ${s.next}, want ${firstOpen} (${what})`);
    check(s.ready === (firstOpen === null), `ready is ${s.ready} with next ${firstOpen} (${what})`);
    check(r.status === (s.ready ? 0 : 1), `fw setup exited ${r.status} with ready ${s.ready} (${what})`);
    s.step = Object.fromEntries(s.steps.map((x) => [x.id, x]));
    return s;
  };

  try {
    // ---- 1. empty home, no fwd ------------------------------------------------------------------
    let s = setup('empty home');
    check(s.fwd === 'down', `fwd is ${s.fwd} with no fwd running, want down`);
    check(s.next === 'machine', `on an empty home next is ${s.next}, want machine`);
    check(/pnpm fwd/.test(s.step.machine.fix), `machine's fix does not say how to start fwd: ${s.step.machine.fix}`);

    // A repository project from the ledger (the way FlowWeb's own work lands), then fwd.
    const proj = fixtureProject({ rowId: 'FW-C-901' });
    check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work, env }).status === 0, 'fw ledger sync failed');
    const f = await startFwd(home, port);

    // ---- 2. fwd running ---------------------------------------------------------------------------
    s = setup('fwd running');
    check(s.fwd === 'up', `fwd is ${s.fwd} while fwd runs, want up`);
    check(s.step.machine.done, `machine is not done while fwd runs: ${s.step.machine.detail}`);
    check(s.next === 'sign_ins', `next is ${s.next}, want sign_ins`);
    check(/fw accounts connect/.test(s.step.sign_ins.fix), `sign_ins fix: ${s.step.sign_ins.fix}`);

    // ---- 3. sign-ins count only from a passing test call --------------------------------------------
    writeFileSync(join(home, 'accounts-check.json'), JSON.stringify(accountsReport(false)));
    s = setup('failed account check');
    check(!s.step.sign_ins.done, 'a failed account test ticked sign_ins');
    writeFileSync(join(home, 'accounts-check.json'), JSON.stringify(accountsReport(true)));
    s = setup('passing account check');
    check(s.step.sign_ins.done, `a passing account test did not tick sign_ins: ${s.step.sign_ins.detail}`);
    check(s.next === 'project', `next is ${s.next}, want project`);
    check(/fw project (add|label)/.test(s.step.project.fix), `project fix: ${s.step.project.fix}`);

    // ---- 4. a project with no repository, labelled while fwd runs -----------------------------------
    let r = fw(['project', 'add', 'launch', '--name', 'Launch campaign', '--kind', 'other', '--brand', 'Frequency', '--json'], { home, env });
    check(r.status === 0, `fw project add with fwd running exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
    r = fw(['project', 'add', 'launch', '--name', 'Again', '--json'], { home, env });
    check(r.status !== 0, 'fw project add accepted a slug that is taken');
    const list = parse(fw(['project', 'list', '--json'], { home, env }), 'fw project list');
    const launch = (list.projects ?? list).filter((p) => p.slug === 'launch');
    check(launch.length === 1 && launch[0].repo_url === null, 'fw project add did not create exactly one project with no repository');
    s = setup('brand but no category');
    check(!s.step.project.done, 'a project with a brand but no category ticked project');
    r = fw(['project', 'label', 'launch', '--category', 'marketing', '--json'], { home, env });
    check(r.status === 0, `fw project label with fwd running exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
    s = setup('labelled project');
    check(s.step.project.done, `a project with a brand and category did not tick project: ${s.step.project.detail}`);
    check(s.next === 'brief', `next is ${s.next}, want brief`);
    check(/fw project brief/.test(s.step.brief.fix), `brief fix: ${s.step.brief.fix}`);

    // ---- 5. the brief: the Owner's own words, all five, or nothing ------------------------------------
    const answers = {
      what: 'Neighborhood events that get people off screens and into rooms together.',
      who: 'Hosts in Encinitas and Carlsbad who already run small gatherings.',
      voice: 'Camp counselor you actually respect. Plain words, no hype, no em dashes.',
      never: 'Never send anything, spend money or promise a date without my OK.',
      done: 'Ten hosts have a first event on the calendar.',
    };
    const briefArgs = (a) => Object.entries(a).flatMap(([k, v]) => [`--${k}`, v]);
    const { done: _skip, ...four } = answers;
    r = fw(['project', 'brief', 'launch', ...briefArgs(four), '--json'], { home, env });
    check(r.status === 2, `a brief missing an answer exited ${r.status}, want 2`);
    r = fw(['project', 'brief', 'launch', ...briefArgs({ ...answers, voice: '   ' }), '--json'], { home, env });
    check(r.status === 2, `a brief with a blank answer exited ${r.status}, want 2`);
    s = setup('refused briefs');
    check(!s.step.brief.done, 'a refused brief ticked brief');
    r = fw(['project', 'brief', 'launch', ...briefArgs(answers), '--json'], { home, env });
    check(r.status === 0, `a full brief with fwd running exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
    const saved = parse(fw(['project', 'brief', 'launch', '--json'], { home, env }), 'fw project brief launch');
    for (const [k, v] of Object.entries(answers))
      check(saved.brief?.[k] === v, `the brief's ${k} did not read back word for word`);
    s = setup('briefed project');
    check(s.step.brief.done, `a full brief did not tick brief: ${s.step.brief.detail}`);
    check(s.next === 'flow', `next is ${s.next}, want flow`);
    check(/fw supervisor enable/.test(s.step.flow.fix), `flow fix: ${s.step.flow.fix}`);

    // ---- 6. the first flow, and ready -----------------------------------------------------------
    r = fw(['supervisor', 'enable', FLOW, '--json'], { home, env });
    check(r.status === 0, `fw supervisor enable ${FLOW} exited ${r.status}`);
    s = setup('flow enabled');
    check(s.step.flow.done, `an enabled flow did not tick flow: ${s.step.flow.detail}`);
    check(s.ready && s.next === null, 'every required step is done but setup is not ready');
    check(!s.step.live_site.done, 'live_site is done with no push from the relay');
    check(/add a machine/i.test(s.step.live_site.fix), `live_site fix does not point at Add a machine: ${s.step.live_site.fix}`);

    // ---- 7. live site, from the relay's last accepted push ------------------------------------------
    const relayToken = fakeSecret();
    writeFileSync(join(home, 'relay.token'), relayToken);
    const pushed = (ms) =>
      writeFileSync(
        join(home, 'relay-last-push.json'),
        JSON.stringify({ synced_at: new Date(Date.now() - ms).toISOString(), site: 'https://flowweb.example' }),
      );
    pushed(3 * 3600_000);
    s = setup('old push');
    check(!s.step.live_site.done, 'a push three hours old ticked live_site');
    pushed(30_000);
    s = setup('recent push');
    check(s.step.live_site.done, `a push 30 seconds old did not tick live_site: ${s.step.live_site.detail}`);

    // ---- 8. the same report from fwd, with no secret in either --------------------------------------
    const g = await get(port, '/v1/setup', f.token);
    if (g.status === 404) missing('GET /v1/setup answered 404');
    check(g.status === 200, `GET /v1/setup answered ${g.status}: ${g.body.slice(0, 200)}`);
    const api = JSON.parse(g.body).data;
    check(
      JSON.stringify(api.steps.map((x) => [x.id, x.done])) === JSON.stringify(s.steps.map((x) => [x.id, x.done])),
      'GET /v1/setup does not answer the same steps as fw setup',
    );
    const cliText = fw(['setup', '--json'], { home, env }).stdout;
    for (const secret of [relayToken, f.token])
      check(!cliText.includes(secret) && !g.body.includes(secret), 'a secret from the home appears in the setup report');

    // ---- 9. fwd stopped again ---------------------------------------------------------------------
    await killAndWait(f.d, 'SIGTERM');
    s = setup('fwd stopped');
    check(s.fwd === 'down' && !s.step.machine.done, 'with fwd stopped, setup still says machine is done');
    check(s.step.brief.done && s.step.project.done, 'with fwd stopped, setup lost the project or brief');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
