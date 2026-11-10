// Shared helper for probes that drive a real fwd over loopback. Tier 0, not a row probe.
// startFwd(home) starts packages/daemon/src/bin.ts on a free port and reads the CLI token it prints;
// api() calls one route with that token (or a cookie, or nothing) and returns { status, json, text, headers };
// pair() trades the pairing code fwd printed for the browser session cookie.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { check, DAEMON_BIN, killAndWait, spawnTs, waitFor } from '../c0/_lib.mjs';

const kids = new Set();
process.on('exit', () => {
  for (const k of kids) {
    try {
      k.kill('SIGKILL');
    } catch {}
  }
});

export function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** Starts fwd on a fresh port for this home. Returns { d, port, token, stop }. */
export async function startFwd(home, { env = {}, args = [], port } = {}) {
  const p = port ?? (await freePort());
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(p), ...args], {
    env: { FW_HOME: home, FW_PORT: String(p), ...env },
  });
  kids.add(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, {
    timeoutMs: 30000,
    what: 'fwd to listen',
  });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  const token = readFileSync(tokenPath, 'utf8').trim();
  const pairingCode = /Pairing code: (\S+)/.exec(d.output())?.[1];
  return {
    d,
    port: p,
    token,
    pairingCode,
    async stop(signal = 'SIGTERM') {
      await killAndWait(d, signal);
      kids.delete(d);
    },
  };
}

/** One HTTP call to fwd on loopback. auth: a token string (Bearer), { cookie }, or null for none. */
export function api(port, method, path, { auth = null, body, headers = {}, timeoutMs = 10000 } = {}) {
  const h = { ...headers };
  if (typeof auth === 'string') h.authorization = `Bearer ${auth}`;
  else if (auth?.cookie) h.cookie = auth.cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((ok, bad) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, timeout: timeoutMs }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        ok({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout calling ${method} ${path}`)));
    req.on('error', bad);
    if (payload) req.write(payload);
    req.end();
  });
}

/** POST /v1/pair with the code; returns { cookie } for api() (the fw_session cookie), or fails. */
export async function pair(port, code) {
  check(code, 'fwd did not print a pairing code (start it with --pair or on a fresh home)');
  const r = await api(port, 'POST', '/v1/pair', { body: { code } });
  const set = [].concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('fw_session='));
  check(r.status === 200 && set, `POST /v1/pair answered ${r.status} without an fw_session cookie`);
  return { cookie: set.split(';')[0] };
}
