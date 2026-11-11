// Probe for FW-C-097 (the site shows a flow as running, and moving, while a cycle is in flight):
// `pnpm probe flows/live-runs`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hang (the cycle
// stays in flight until fwd stops), GET /v1/supervisor and the Owner controls under /v1/supervisor with
// the CLI token fwd prints, the cycle folders $FW_HOME/flows/<key>/cycles/, and the web components
// FlowHero (packages/web/src/flows/FlowHero.tsx), FlowControls and LiveProvider (src/api/live.tsx), whose
// checks are in probes/flows/live-runs.spec.tsx, run with vitest in jsdom against a fetch stub.
//
// The premise (2026-11-10, the Owner's Mac): three hunt cycles of the same flow ran at once from 16:00 to
// 16:03 while GET /v1/supervisor answered running 0 and "Nothing is due", so the site never moved.
//
// Proves, in order:
//   1. Before a run, the flow is not running and the Supervisor counts 0 running.
//   2. While a cycle is in flight, GET /v1/supervisor answers the flow's state "running" and running 1.
//   3. A second run of the same flow while the first is in flight is held at the flow's wip limit, and
//      no second cycle folder appears.
//   4. The site: a running flow gives its hero card and its Controls row a live class and a pulsing dot;
//      an idle flow has none; on the hosted mirror a newer push refreshes the page without a reload.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, pidsInDir, probe, root, spawnTs, tmpDir, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/live-runs';
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

function http(port, method, path, token) {
  return new Promise((ok, bad) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${token}` }, timeout: 10000 },
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

const home = freshHome('live-runs');
const cycles = join(home, 'flows', KEY, 'cycles');
const dirs = () => {
  try {
    return readdirSync(cycles);
  } catch {
    return [];
  }
};

await probe(NAME, async () => {
  try {
    const port = await freePort();
    const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], {
      env: { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hang' },
    });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
    check(tokenPath, 'fwd did not print "CLI token file: <path>"');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const supervisor = async () => JSON.parse((await http(port, 'GET', '/v1/supervisor', token)).body).data;
    const theFlow = (s) => s.flows.find((f) => f.key === KEY);

    // ---- 1. idle before a run -------------------------------------------------------------------
    const en = await http(port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, token);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}`);
    let s = await supervisor();
    check(s.running === 0 && theFlow(s)?.state !== 'running', `before a run: running ${s.running}, state ${theFlow(s)?.state}`);

    // ---- 2. running while a cycle is in flight -------------------------------------------------
    const run = JSON.parse((await http(port, 'POST', `/v1/supervisor/flows/${KEY}/run`, token)).body)?.data;
    check(run?.outcome === 'fired', `running ${KEY}: ${JSON.stringify(run)}, want fired`);
    await waitFor(() => dirs().length === 1, { timeoutMs: 20000, everyMs: 200, what: 'the cycle folder' });
    await waitFor(
      async () => {
        s = await supervisor();
        return theFlow(s)?.state === 'running';
      },
      { timeoutMs: 5000, everyMs: 200, what: `GET /v1/supervisor to say ${KEY} is running` },
    ).catch(() => {});
    check(
      theFlow(s)?.state === 'running' && s.running === 1,
      `with a cycle in flight GET /v1/supervisor answers state ${theFlow(s)?.state}, running ${s.running}; want running, 1`,
    );

    // ---- 3. a second run waits at the wip limit -------------------------------------------------
    const again = JSON.parse((await http(port, 'POST', `/v1/supervisor/flows/${KEY}/run`, token)).body)?.data;
    check(
      again?.outcome !== 'fired' && /^wip\b/.test(String(again?.reason ?? '')),
      `a second run while one is in flight answered ${JSON.stringify(again)}; want it held at wip`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    check(dirs().length === 1, `a held second run still started a cycle (${dirs().length} cycle folders)`);
    await killAndWait(d, 'SIGTERM');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
    for (const pid of pidsInDir(cycles)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }

  // ---- 4. the site ------------------------------------------------------------------------------
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('live-runs'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/live-runs.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the live-run site checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+3 passed/.test(out), `expected 3 live-run site checks to pass:\n${out.slice(-400)}`);
});
