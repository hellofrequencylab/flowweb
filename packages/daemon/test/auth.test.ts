// fwd auth: pairing code -> HttpOnly SameSite=Strict cookie, CLI Bearer token, Host header guard
// (DNS rebinding) and the cross-origin write guard.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MAX_PAIR_ATTEMPTS, PairingStore } from '../src/auth.ts';
import { type Daemon, startDaemon } from '../src/daemon.ts';
import { call, tempHome } from './api-fixtures.ts';

const home = tempHome();
let d: Daemon;

beforeAll(async () => {
  d = await startDaemon({ fwHome: home.path, port: 0, log: () => {} });
});

afterAll(async () => {
  await d?.stop('test done');
  home.cleanup();
});

describe('FW_HOME layout', () => {
  test('directories are 0700 and the token files are 0600', () => {
    for (const dir of ['', 'db', 'worktrees', 'runs', 'pairing']) {
      expect(statSync(join(home.path, dir)).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(home.path, 'pairing', 'cli.token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home.path, 'pairing', 'code')).mode & 0o777).toBe(0o600);
  });
});

describe('auth', () => {
  test('first start has a pairing code; no cookie or token means 401', async () => {
    expect(d.pairingCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const res = await call(d.port, 'GET', '/v1/status');
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('unauthorized');
    const badCookie = await call(d.port, 'GET', '/v1/status', { headers: { cookie: 'fw_session=forged' } });
    expect(badCookie.status).toBe(401);
    const badBearer = await call(d.port, 'GET', '/v1/status', { headers: { authorization: 'Bearer nope' } });
    expect(badBearer.status).toBe(401);
  });

  test('the CLI token file authenticates as Bearer', async () => {
    const token = readFileSync(d.cliTokenPath, 'utf8').trim();
    const res = await call(d.port, 'GET', '/v1/status', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.json.data.daemon).toBe('up');
  });

  test('pairing needs a JSON body and the right code; the cookie is HttpOnly SameSite=Strict; the code works once', async () => {
    const form = await call(d.port, 'POST', '/v1/pair', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(400);
    const wrong = await call(d.port, 'POST', '/v1/pair', { body: { code: 'AAAA-AAAA' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await call(d.port, 'POST', '/v1/pair', {
      body: { code: d.pairingCode!.toLowerCase(), device_label: 'test browser' },
    });
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/^fw_session=[A-Za-z0-9_-]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(ok.json.data.device_label).toBe('test browser');

    const session = cookie.split(';')[0]!;
    const status = await call(d.port, 'GET', '/v1/status', { headers: { cookie: session } });
    expect(status.status).toBe(200);
    const me = await call(d.port, 'GET', '/v1/session', { headers: { cookie: `other=1; ${session}` } });
    expect(me.json.data).toEqual({ paired_at: ok.json.data.paired_at, device_label: 'test browser' });

    // Starting a run is for the CLI token only, never a browser session.
    const run = await call(d.port, 'POST', '/v1/runs', {
      headers: { cookie: session },
      body: { code: 'FW-C-001', repo_dir: '/tmp' },
    });
    expect(run.status).toBe(403);
    expect(run.json.error.code).toBe('forbidden');

    const again = await call(d.port, 'POST', '/v1/pair', { body: { code: d.pairingCode } });
    expect(again.status).toBe(401);
    // Only the hash of the session token is stored.
    expect(readFileSync(join(home.path, 'pairing', 'sessions.json'), 'utf8')).not.toContain(
      session.split('=')[1]!,
    );
  });

  test('a burst of wrong codes burns the pending code', () => {
    const p = new PairingStore(join(home.path, 'pairing'));
    const code = p.ensurePairingCode(true)!;
    for (let i = 0; i < MAX_PAIR_ATTEMPTS; i++) expect('refused' in p.pair('WRNG-CODE', null)).toBe(true);
    expect(p.pair(code, null)).toEqual({ refused: expect.stringContaining('--pair') });
  });

  test('DNS rebinding guard: a foreign or missing-port Host is refused before auth', async () => {
    for (const host of ['evil.example', `evil.example:${d.port}`, '127.0.0.1', `127.0.0.1:${d.port + 1}`]) {
      const res = await call(d.port, 'GET', '/v1/status', { headers: { host } });
      expect(res.status, host).toBe(403);
      expect(res.json.error.code).toBe('forbidden');
    }
    const token = readFileSync(d.cliTokenPath, 'utf8').trim();
    const local = await call(d.port, 'GET', '/v1/status', {
      headers: { host: `localhost:${d.port}`, authorization: `Bearer ${token}` },
    });
    expect(local.status).toBe(200);
  });

  test('cross-origin writes are refused; same-origin and no-origin (CLI) pass the guard', async () => {
    const evil = await call(d.port, 'POST', '/v1/pair', {
      headers: { origin: 'http://evil.example' },
      body: { code: 'x' },
    });
    expect(evil.status).toBe(403);
    const site = await call(d.port, 'POST', '/v1/pair', {
      headers: { 'sec-fetch-site': 'cross-site' },
      body: { code: 'x' },
    });
    expect(site.status).toBe(403);
    const same = await call(d.port, 'POST', '/v1/pair', {
      headers: { origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'same-origin' },
      body: { code: 'x' },
    });
    expect(same.status).toBe(401); // past the guard, wrong code
  });
});
