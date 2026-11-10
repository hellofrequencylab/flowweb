// Probe for FW-C-043 (hunt cycles can search and read the public web): `pnpm probe flows/hunt-web`. Tier 0.
// Surfaces: buildCodexArgv and buildClaudeArgv from @fw/adapters (run under tsx), and the daemon fwd on a
// fresh FW_HOME with FW_VENDOR=fake and FW_FAKE_SCENARIO=hunt_leads, its hunt and Supervisor routes, and
// the cycle folders $FW_HOME/flows/<key>/cycles/<fire>/.
// The surface this probe expects:
//   StartOptions.web (boolean, default false) lets one run search and read the public web.
//   buildCodexArgv({ ..., web: true }) adds --config sandbox_workspace_write.network_access=true and
//   --config web_search="live"; without web neither appears. buildClaudeArgv({ ..., web: true }) adds
//   WebSearch and WebFetch to --allowed-tools, keeping any tools already allowed; without web neither
//   appears. A flow cycle starts its adapter with web: true only when at least one hunt is due in it.
//   The fake vendor writes web.json ({ "web": true|false }) in its working folder, from what it was
//   started with.
//
// Proves, in order:
//   1. Codex: web off by default; web on adds network access and live web search.
//   2. Claude: web off by default; web on adds WebSearch and WebFetch next to tools already allowed.
//   3. A cycle that runs a hunt starts its adapter with web on; a cycle with no hunt due keeps it off.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  DAEMON_BIN,
  freshHome,
  killAndWait,
  missing,
  probe,
  root,
  spawnTs,
  tmpDir,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/hunt-web';
const KEY = 'neighborhood-activation';
const kids = [];

function argvs() {
  const dir = tmpDir('hunt-web-argv');
  const file = join(dir, 'argv.ts');
  const src = pathToFileURL(join(root, 'packages/adapters/src/index.ts')).href;
  writeFileSync(
    file,
    `import { buildClaudeArgv, buildCodexArgv } from ${JSON.stringify(src)};
const cx = new Set(['--json', '--sandbox', '--config', '--output-schema']);
const cl = new Set(['--print', '--output-format', '--verbose', '--bare', '--permission-mode', '--json-schema', '--session-id', '--allowed-tools']);
const base = { verified: cl, sessionId: 's1', resumeSessionId: null, permissionMode: 'acceptEdits' };
const out = {
  codexOff: buildCodexArgv({ verified: cx, resumeSessionId: null, schemaPath: '/s.json' }),
  codexOn: buildCodexArgv({ verified: cx, resumeSessionId: null, schemaPath: '/s.json', web: true } as never),
  claudeOff: buildClaudeArgv(base),
  claudeOn: buildClaudeArgv({ ...base, web: true } as never),
  claudeOnKeep: buildClaudeArgv({ ...base, allowedTools: ['Read'], web: true } as never),
};
process.stdout.write(JSON.stringify(out));
`,
  );
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', loader, file], { cwd: root, encoding: 'utf8', timeout: 30000 });
  check(r.status === 0, `building argv failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return JSON.parse(r.stdout);
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

function http(port, method, path, token, body) {
  return new Promise((ok, bad) => {
    const headers = { authorization: `Bearer ${token}` };
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 10000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => ok({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return undefined;
  }
};

await probe(NAME, async () => {
  // ---- 1 and 2. the argv ----------------------------------------------------------------------------
  const a = argvs();
  const has = (argv, s) => argv.some((x) => x.includes(s));
  check(!has(a.codexOff, 'network_access') && !has(a.codexOff, 'web_search'), `codex without web: ${a.codexOff.join(' ')}`);
  const cfgs = a.codexOn.flatMap((x, i) => (x === '--config' ? [a.codexOn[i + 1]] : []));
  if (!cfgs.includes('sandbox_workspace_write.network_access=true'))
    missing(`codex with web has no network access: ${a.codexOn.join(' ')}`);
  check(cfgs.includes('web_search="live"'), `codex with web has no live web search: ${a.codexOn.join(' ')}`);
  check(a.codexOn.at(-1) === '-', 'codex argv must still end with - (prompt on stdin)');
  const tools = (argv) => {
    const i = argv.indexOf('--allowed-tools');
    return i < 0 ? [] : argv[i + 1].split(',');
  };
  check(!tools(a.claudeOff).some((t) => /^Web/.test(t)), `claude without web allows ${tools(a.claudeOff)}`);
  check(tools(a.claudeOn).includes('WebSearch') && tools(a.claudeOn).includes('WebFetch'), `claude with web allows ${tools(a.claudeOn)}`);
  check(
    ['Read', 'WebSearch', 'WebFetch'].every((t) => tools(a.claudeOnKeep).includes(t)),
    `claude with web dropped tools already allowed: ${tools(a.claudeOnKeep)}`,
  );

  // ---- 3. a hunt cycle runs with web on, a plain cycle without ------------------------------------
  const home = freshHome('hunt-web');
  try {
    const port = await freePort();
    const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], {
      env: { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' },
    });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const token = readFileSync(/CLI token file: (\S+)/.exec(d.output())?.[1] ?? '', 'utf8').trim();
    const api = (m, p, b) => http(port, m, p, token, b);
    const cycles = join(home, 'flows', KEY, 'cycles');
    const webOf = (fire) => {
      const p = join(cycles, fire.replace(/[^A-Za-z0-9_-]/g, '_'), 'web.json');
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).web : undefined;
    };
    check((await api('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, 'enabling the flow failed');

    const plain = json(await api('POST', `/v1/supervisor/flows/${KEY}/run`))?.data;
    check(plain?.outcome === 'fired', `a plain run: ${JSON.stringify(plain)}`);
    await waitFor(() => webOf(plain.fire_id) !== undefined, { timeoutMs: 30000, everyMs: 250, what: 'the plain cycle to start' });
    check(webOf(plain.fire_id) === false, 'a cycle with no hunt due started with web on');

    const made = json(
      await api('POST', `/v1/flows/${KEY}/hunts`, { name: 'Web', looking_for: 'sound baths', region: 'north-county-sd' }),
    )?.data;
    check(typeof made?.id === 'string', 'saving a hunt failed');
    // The plain run may still be finishing; ask until the hunt run fires.
    let hunt;
    await waitFor(
      async () => {
        hunt = json(await api('POST', `/v1/flows/${KEY}/hunts/${made.id}/run`))?.data;
        return hunt?.outcome === 'fired';
      },
      { timeoutMs: 30000, everyMs: 500, what: 'the hunt run to fire' },
    );
    await waitFor(() => webOf(hunt.fire_id) !== undefined, { timeoutMs: 30000, everyMs: 250, what: 'the hunt cycle to start' });
    check(webOf(hunt.fire_id) === true, `a hunt cycle started with web ${webOf(hunt.fire_id)}, want true`);
    check(readdirSync(cycles).length >= 2, 'fewer than two cycle folders');
  } finally {
    for (const k of kids) await killAndWait(k);
  }
});
