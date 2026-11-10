// Probe for FW-C-096 (one Frequency Saturation Engine flow, aimed at the Owner's crowd):
// `pnpm probe flows/saturation-engine`. Tier 0.
// Surfaces: flows/neighborhood-activation/ and flows/local-saturation/ (stream.json, config.json), the hunt
// brief in packages/daemon/src/overseer/cycle.ts (brief, audienceOf), the daemon fwd (one node process on a
// fresh FW_HOME) with GET /v1/supervisor, and packages/web/src/flows/visible.ts (liveFlows) as used by the
// Flows home, Today and the footer. The TypeScript is loaded with the repo's tsx loader in a child.
//
// The surface this probe expects:
//   The flow keyed neighborhood-activation is named "Frequency Saturation Engine". The old local saturation
//   flow's config.json says merged_into "neighborhood-activation"; it still ships (other probes use it) but
//   the site no longer shows it as a second flow.
//   config.json hunts.audience = { focus: [...], steer_away: [...] }: focus names breathwork, yoga, sound
//   healing, transformative experiences, maker events, swaps, art, music, expression and ecstatic dance;
//   steer_away names programs for seniors and plain craft classes.
//   audienceOf(dir) reads hunts.audience from the config.json in a cycle folder ({focus:[],steer_away:[]}
//   without one). brief(key, stream, hunts, funnels, learned, audience) puts every focus and steer_away item
//   in a hunt cycle's brief, and asks its generic question without "people nearby who enjoy making things"
//   (that phrase stays only inside the Owner's own quoted example). runFlowCycle passes audienceOf(dir).
//   GET /v1/supervisor gives each flow merged_into: the merged flow's target key, else null.
//   liveFlows(list) drops flows with a merged_into; FlowsHome and Today list flows through it.
//
// Proves, in order:
//   1. The shipped definitions: the name, merged_into and the audience lists.
//   2. A hunt brief carries the audience and drops the crafts-only question.
//   3. fwd reports merged_into on the Supervisor.
//   4. The site hides the merged flow and names the engine in the footer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, root, spawnTs, tmpDir, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/saturation-engine';
const NA = join(root, 'flows/neighborhood-activation');
const LS = join(root, 'flows/local-saturation');
const CYCLE_TS = join(root, 'packages/daemon/src/overseer/cycle.ts');
const VISIBLE_TS = join(root, 'packages/web/src/flows/visible.ts');
const ENGINE = 'Frequency Saturation Engine';
const FOCUS = [/breathwork/i, /yoga/i, /sound (healing|bath)/i, /transformative/i, /maker/i, /swap/i, /\bart\b/i, /music/i, /express/i, /ecstatic dance/i];
const kids = [];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function runTs(code) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  });
  check(r.status === 0, `loading the TypeScript failed: ${(r.stderr || r.stdout || '').slice(0, 600)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

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

await probe(NAME, async () => {
  // ---- 1. definitions --------------------------------------------------------------------
  const stream = readJson(join(NA, 'stream.json'));
  check(stream.name === ENGINE, `flows/neighborhood-activation/stream.json is named "${stream.name}", want "${ENGINE}"`);
  const old = readJson(join(LS, 'config.json'));
  check(old.merged_into === 'neighborhood-activation', `flows/local-saturation/config.json merged_into is ${JSON.stringify(old.merged_into)}`);
  const cfg = readJson(join(NA, 'config.json'));
  const aud = cfg.hunts?.audience;
  check(aud && Array.isArray(aud.focus) && Array.isArray(aud.steer_away), 'config.json hunts.audience has no focus and steer_away lists');
  const focus = aud.focus.join(' | ');
  for (const re of FOCUS) check(re.test(focus), `hunts.audience.focus does not name ${re}: ${focus}`);
  const away = aud.steer_away.join(' | ');
  check(/senior/i.test(away), `hunts.audience.steer_away does not name programs for seniors: ${away}`);
  check(/craft/i.test(away), `hunts.audience.steer_away does not name plain craft classes: ${away}`);
  check(![...aud.focus, ...aud.steer_away].some((s) => /[–—]/.test(String(s))), 'an audience item holds an em or en dash');

  // ---- 2. the brief ----------------------------------------------------------------------
  const cycleSrc = readFileSync(CYCLE_TS, 'utf8');
  if (!/export function audienceOf\(/.test(cycleSrc)) missing('cycle.ts exports no audienceOf (row FW-C-096)');
  check(/audienceOf\(dir\)/.test(cycleSrc), 'runFlowCycle does not pass audienceOf(dir) to the brief');
  const dir = tmpDir('sat-engine');
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  const empty = tmpDir('sat-engine-empty');
  const out = runTs(`
    const c = await import(${JSON.stringify(pathToFileURL(CYCLE_TS).href)});
    const a = c.audienceOf(${JSON.stringify(dir)});
    const none = c.audienceOf(${JSON.stringify(empty)});
    const hunt = { id: 'hnt_1', name: 'North County', looking_for: 'events', region: 'north-county-sd', areas: [], links: [], every_days: 1, max_sends: 5, build: false, enabled: true };
    const text = c.brief('neighborhood-activation', ${JSON.stringify(stream)}, [hunt], ['host'], false, a);
    console.log(JSON.stringify({ a, none, text }));
  `);
  check(JSON.stringify(out.a?.focus) === JSON.stringify(aud.focus), 'audienceOf does not read hunts.audience.focus from the cycle folder');
  check(JSON.stringify(out.none) === JSON.stringify({ focus: [], steer_away: [] }), `audienceOf without a config gives ${JSON.stringify(out.none)}`);
  const text = String(out.text);
  check(text.includes(ENGINE), 'the brief does not name the Frequency Saturation Engine');
  for (const s of [...aud.focus, ...aud.steer_away]) check(text.includes(s), `the hunt brief leaves out "${s}"`);
  check(text.split('enjoy making things').length - 1 === 1, 'the hunt brief still asks about "people nearby who enjoy making things" outside the Owner\'s own example');
  check(text.includes('Sounds like a lovely way to spend an evening with the community!'), "the hunt brief lost the Owner's own example");

  // ---- 3. fwd ----------------------------------------------------------------------------
  const home = freshHome('sat-engine');
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
  kids.push(d);
  try {
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
    check(tokenPath, 'fwd did not print "CLI token file: <path>"');
    const r = await get(port, '/v1/supervisor', readFileSync(tokenPath, 'utf8').trim());
    check(r.status === 200, `GET /v1/supervisor answered ${r.status}: ${r.body.slice(0, 200)}`);
    const flows = JSON.parse(r.body).data.flows;
    const of = (k) => flows.find((x) => x.key === k);
    check(of('local-saturation')?.merged_into === 'neighborhood-activation', `GET /v1/supervisor gives local-saturation merged_into ${JSON.stringify(of('local-saturation')?.merged_into)}`);
    check(of('neighborhood-activation')?.merged_into === null, 'GET /v1/supervisor gives the engine a merged_into');
    check(of('neighborhood-activation')?.name === ENGINE, `GET /v1/supervisor names the engine "${of('neighborhood-activation')?.name}"`);
  } finally {
    for (const k of kids) await killAndWait(k);
  }

  // ---- 4. the site -----------------------------------------------------------------------
  if (!existsSync(VISIBLE_TS)) missing('packages/web/src/flows/visible.ts does not exist (row FW-C-096)');
  const live = runTs(`
    const m = await import(${JSON.stringify(pathToFileURL(VISIBLE_TS).href)});
    console.log(JSON.stringify(m.liveFlows([
      { key: 'local-saturation', merged_into: 'neighborhood-activation' },
      { key: 'neighborhood-activation', merged_into: null },
      { key: 'paid-ads' },
    ]).map((f) => f.key)));
  `);
  check(JSON.stringify(live) === JSON.stringify(['neighborhood-activation', 'paid-ads']), `liveFlows kept ${JSON.stringify(live)}`);
  for (const f of ['packages/web/src/flows/FlowsHome.tsx', 'packages/web/src/dawn/Today.tsx'])
    check(/liveFlows\(/.test(readFileSync(join(root, f), 'utf8')), `${f} does not list flows through liveFlows`);
  check(readFileSync(join(root, 'packages/web/src/shell/Footer.tsx'), 'utf8').includes(ENGINE), 'the footer does not name the Frequency Saturation Engine');
});
