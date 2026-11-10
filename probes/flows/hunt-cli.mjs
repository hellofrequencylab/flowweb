// Probe for FW-C-048 (the Owner saves, lists, runs and removes lead hunts, and blocks an address, from
// `fw hunt`): `pnpm probe flows/hunt-cli`. Tier 0.
// Surfaces: the fw CLI (packages/cli/src/bin.ts) with FW_HOME and FW_PORT naming a running fwd, fwd itself
// on a fresh FW_HOME (FW_VENDOR=fake, FW_FAKE_SCENARIO=hunt_leads), the hunt routes under
// /v1/flows/neighborhood-activation/hunts, the do-not-contact route, and the flow's state.json.
// The surface this probe expects (every command goes through fwd with the CLI token; with fwd down each
// exits non-zero and says fwd is not running):
//   fw hunt add --name <text> --looking-for <text> --region <id> [--area <id>]... [--link <url>]...
//              [--every <days>] [--max <sends per run>] [--build]
//     saves one hunt (POST .../hunts). --link and --area may be given more than once; each --link is a
//     page searched first. --json prints the saved hunt. fwd's refusal (a bad link, an unknown region)
//     exits non-zero and saves nothing.
//   fw hunt list            the saved hunts (--json: the array fwd answers).
//   fw hunt run <id>        asks for that hunt in the next cycle and fires the flow by hand (--json:
//                           { hunt_id, fire_id, outcome, reason? }).
//   fw hunt remove <id>     deletes one (--json: { deleted }).
//   fw hunt block <address or @domain> --reason <text>
//                           adds it to the flow's do-not-contact list, for an organizer who replied "no"
//                           (--json: { blocked, already }). --reason is required.
//
// Proves, in order:
//   1. With fwd down, fw hunt list exits non-zero and says fwd is not running.
//   2. fw hunt add saves a hunt with two links, an area, every and max; --build saves a build hunt; a bad
//      link is refused and saves nothing.
//   3. fw hunt list shows both, as JSON and as text with their names.
//   4. fw hunt block adds an address and an @domain to state.json; an address that is neither is
//      refused; without --reason it is a usage error.
//   5. fw hunt run fires the flow for that hunt; fw hunt remove deletes the other.
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, fw, fwJson, killAndWait, missing, probe, root, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/hunt-cli';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}/hunts`;
const L1 = 'https://example.com/events/encinitas';
const L2 = 'https://example.org/calendar';
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

function http(port, method, path, token, body) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
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

await probe(NAME, async () => {
  if (!existsSync(join(root, 'packages/cli/src/bin.ts'))) missing('packages/cli/src/bin.ts does not exist');
  const home = freshHome('hunt-cli');
  const port = await freePort();
  const env = { FW_PORT: String(port) };
  try {
    // ---- 1. fwd down ---------------------------------------------------------------------------------
    const down = fw(['hunt', 'list'], { home, env });
    check(down.status !== 0, 'fw hunt list exited 0 with fwd down');
    check(/unknown command/i.test(down.stderr) === false, `fw hunt is not a command: ${down.stderr.trim().slice(0, 200)}`);
    check(/fwd/i.test(down.stderr), `fw hunt list with fwd down does not say so: ${down.stderr.trim().slice(0, 200)}`);

    const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], {
      env: { FW_HOME: home, FW_VENDOR: 'fake', FW_FAKE_SCENARIO: 'hunt_leads' },
    });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
    check(tokenPath, 'fwd did not print "CLI token file: <path>"');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const api = (method, path, body) => http(port, method, path, token, body);
    const saved = async () => JSON.parse((await api('GET', BASE)).body).data ?? [];

    // ---- 2. add ---------------------------------------------------------------------------------------
    const a = fwJson(
      ['hunt', 'add', '--name', 'Sound baths', '--looking-for', 'sound baths and breathwork', '--region', 'north-county-sd',
        '--area', 'encinitas', '--link', L1, '--link', L2, '--every', '3', '--max', '5'],
      { home, env },
    );
    check(a.status === 0, `fw hunt add exited ${a.status}: ${a.stderr.slice(0, 200)}`);
    const h1 = a.json;
    check(
      typeof h1?.id === 'string' && h1.name === 'Sound baths' && h1.region === 'north-county-sd' &&
        JSON.stringify(h1.areas) === JSON.stringify(['encinitas']) && JSON.stringify(h1.links) === JSON.stringify([L1, L2]) &&
        h1.every_days === 3 && h1.max_sends === 5 && h1.build === false,
      `fw hunt add --json printed ${JSON.stringify(h1)}`,
    );
    const b = fwJson(['hunt', 'add', '--name', 'Markets', '--looking-for', 'night markets', '--region', 'north-county-sd', '--build'], { home, env });
    check(b.status === 0 && b.json?.build === true, `fw hunt add --build: exit ${b.status}, ${JSON.stringify(b.json)}`);
    const h2 = b.json;
    const bad = fw(['hunt', 'add', '--name', 'Bad', '--looking-for', 'x', '--region', 'north-county-sd', '--link', 'javascript:alert(1)'], { home, env });
    check(bad.status !== 0, 'fw hunt add with a bad link exited 0');
    check((await saved()).length === 2, `after a refused add fwd holds ${(await saved()).length} hunts, want 2`);

    // ---- 3. list --------------------------------------------------------------------------------------
    const l = fwJson(['hunt', 'list'], { home, env });
    check(l.status === 0 && Array.isArray(l.json) && l.json.length === 2, `fw hunt list --json: ${JSON.stringify(l.json).slice(0, 200)}`);
    const lt = fw(['hunt', 'list'], { home, env });
    check(lt.status === 0 && /Sound baths/.test(lt.stdout) && /Markets/.test(lt.stdout), `fw hunt list text: ${lt.stdout.slice(0, 200)}`);

    // ---- 4. block --------------------------------------------------------------------------------------
    const k1 = fwJson(['hunt', 'block', 'Organizer@Example.com', '--reason', 'replied no'], { home, env });
    check(k1.status === 0 && k1.json?.blocked === 'organizer@example.com', `fw hunt block: exit ${k1.status}, ${JSON.stringify(k1.json)}`);
    const k2 = fw(['hunt', 'block', '@example.net', '--reason', 'the whole studio asked'], { home, env });
    check(k2.status === 0, `fw hunt block @domain exited ${k2.status}: ${k2.stderr.slice(0, 200)}`);
    const state = JSON.parse(readFileSync(join(home, 'flows', KEY, 'state.json'), 'utf8'));
    check(
      state.do_not_contact.includes('organizer@example.com') && state.do_not_contact.includes('@example.net'),
      `do_not_contact: ${JSON.stringify(state.do_not_contact)}`,
    );
    check(fw(['hunt', 'block', 'not-an-address', '--reason', 'x'], { home, env }).status !== 0, 'fw hunt block took something that is not an address');
    check(fw(['hunt', 'block', 'a@example.com'], { home, env }).status === 2, 'fw hunt block without --reason is not a usage error');

    // ---- 5. run and remove ----------------------------------------------------------------------------
    const en = await api('POST', `/v1/supervisor/flows/${KEY}/enable`);
    check(en.status === 200, `enabling ${KEY} answered ${en.status}`);
    const r = fwJson(['hunt', 'run', h1.id], { home, env });
    check(r.status === 0 && r.json?.hunt_id === h1.id && r.json?.outcome === 'fired' && typeof r.json?.fire_id === 'string',
      `fw hunt run: exit ${r.status}, ${JSON.stringify(r.json)}`);
    const rm = fwJson(['hunt', 'remove', h2.id], { home, env });
    check(rm.status === 0 && rm.json?.deleted === h2.id, `fw hunt remove: exit ${rm.status}, ${JSON.stringify(rm.json)}`);
    const left = await saved();
    check(left.length === 1 && left[0].id === h1.id, `after remove fwd holds ${JSON.stringify(left.map((x) => x.id))}`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
