// The checks for FW-C-080; run by probes/ui/sign-in-methods.mjs (not on its own). Tier 0.
// Supabase Auth and the hosted /v1 are stood in by a fetch stub. hosted/auth.ts reads its settings when it
// loads, so each check loads a fresh copy under the env it needs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPA = 'https://supa.example';
const KEY = 'anon-key-for-tests';
const SITE = 'https://flowweb.example';

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let answer: (c: Call) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (email: string) =>
  `${b64({ alg: 'none' })}.${b64({ email, exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' })}.sig`;
const session = (email: string) => ({
  access_token: jwt(email),
  refresh_token: 'refresh-1',
  expires_in: 3600,
  token_type: 'bearer',
  user: { email },
});

type Auth = Record<string, unknown> & {
  authMethods: { password: boolean; link: boolean; google: boolean };
  signInWithPassword(e: string, p: string): Promise<unknown>;
  signUp(e: string, p: string): Promise<{ needsConfirm: boolean }>;
  sendLink(e: string): Promise<void>;
  googleUrl(): string;
  sendPasswordReset(e: string): Promise<void>;
  setPassword(p: string): Promise<void>;
  signOut(): Promise<void>;
  consumeRedirect(): { kind: 'signin' | 'recovery' | null; error: string | null };
  signedInEmail(): string | null;
  accessToken(): Promise<string | null>;
  listAccounts(): Promise<unknown>;
  createAccount(name: string): Promise<unknown>;
  acceptInvite(token: string): Promise<unknown>;
};

async function load(extra: Record<string, string> = {}): Promise<Auth> {
  vi.resetModules();
  vi.stubEnv('VITE_FW_HOSTED', '1');
  vi.stubEnv('VITE_SUPABASE_URL', SUPA);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', KEY);
  vi.stubEnv('VITE_FW_AUTH_GOOGLE', '');
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  return (await import('../../packages/web/src/hosted/auth')) as unknown as Auth;
}

const lower = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

beforeEach(() => {
  calls = [];
  answer = () => ({ status: 200, body: {} });
  localStorage.clear();
  history.replaceState(null, '', '/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), SITE).toString();
      let body: unknown = init.body;
      try {
        body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      } catch {
        /* not json */
      }
      const call = { method: (init.method ?? 'GET').toUpperCase(), url, body, headers: lower(init.headers) };
      calls.push(call);
      const a = answer(call);
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const last = () => calls[calls.length - 1]!;
const isOurs = (msg: string, ...foreign: string[]) => {
  expect(msg.length).toBeGreaterThan(10);
  for (const f of foreign) expect(msg).not.toContain(f);
};

describe('FlowWeb sign-in methods', () => {
  it('offers password and link always, and Google only when its switch is on', async () => {
    expect((await load()).authMethods).toEqual({ password: true, link: true, google: false });
    expect((await load({ VITE_FW_AUTH_GOOGLE: '1' })).authMethods.google).toBe(true);
  });

  it('signs in with email and password and keeps the session', async () => {
    const a = await load();
    answer = () => ({ status: 200, body: session('friend@example.com') });
    await a.signInWithPassword('friend@example.com', 'correct horse');
    const c = last();
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${SUPA}/auth/v1/token?grant_type=password`);
    expect(c.body).toEqual({ email: 'friend@example.com', password: 'correct horse' });
    expect(c.headers.apikey).toBe(KEY);
    expect(a.signedInEmail()).toBe('friend@example.com');
    expect(await a.accessToken()).toMatch(/^[\w-]+\.[\w-]+\.sig$/);
  });

  it('turns wrong credentials into our own sentence', async () => {
    const a = await load();
    answer = () => ({
      status: 400,
      body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
    });
    const e = (await a.signInWithPassword('friend@example.com', 'nope').catch((x: Error) => x)) as Error;
    expect(e).toBeInstanceOf(Error);
    isOurs(e.message, 'Invalid login credentials');
    expect(e.message).toMatch(/password/i);
    expect(a.signedInEmail()).toBeNull();
  });

  it('signs up, and says when the email must be confirmed first', async () => {
    const a = await load();
    answer = () => ({ status: 200, body: { id: 'u2', email: 'new@example.com', confirmation_sent_at: 'x' } });
    expect(await a.signUp('new@example.com', 'long enough pw')).toEqual({ needsConfirm: true });
    const c = last();
    expect(c.method).toBe('POST');
    expect(c.url.startsWith(`${SUPA}/auth/v1/signup`)).toBe(true);
    expect(c.body).toMatchObject({ email: 'new@example.com', password: 'long enough pw' });
    expect(a.signedInEmail()).toBeNull();

    answer = () => ({ status: 200, body: session('instant@example.com') });
    expect(await a.signUp('instant@example.com', 'long enough pw')).toEqual({ needsConfirm: false });
    expect(a.signedInEmail()).toBe('instant@example.com');
  });

  it('says plainly when an email already has a login', async () => {
    const a = await load();
    answer = () => ({ status: 422, body: { code: 422, error_code: 'user_already_exists', msg: 'User already registered' } });
    const e = (await a.signUp('taken@example.com', 'long enough pw').catch((x: Error) => x)) as Error;
    expect(e).toBeInstanceOf(Error);
    isOurs(e.message, 'User already registered');
  });

  it('sends a magic link that can create the login, and a password reset', async () => {
    const a = await load();
    await a.sendLink('friend@example.com');
    let c = last();
    expect(c.url.startsWith(`${SUPA}/auth/v1/otp`)).toBe(true);
    expect(c.body).toMatchObject({ email: 'friend@example.com', create_user: true });

    await a.sendPasswordReset('friend@example.com');
    c = last();
    expect(c.method).toBe('POST');
    expect(c.url.startsWith(`${SUPA}/auth/v1/recover`)).toBe(true);
    expect(c.body).toMatchObject({ email: 'friend@example.com' });
  });

  it('builds the Google sign-in address back to this site', async () => {
    const a = await load({ VITE_FW_AUTH_GOOGLE: '1' });
    const u = new URL(a.googleUrl());
    expect(`${u.origin}${u.pathname}`).toBe(`${SUPA}/auth/v1/authorize`);
    expect(u.searchParams.get('provider')).toBe('google');
    expect(u.searchParams.get('redirect_to')).toBe(`${SITE}/`);
  });

  it('reads a landed link: recovery, sign-in, an error in our words, or nothing', async () => {
    let a = await load();
    expect(a.consumeRedirect()).toEqual({ kind: null, error: null });

    const tok = session('friend@example.com').access_token;
    history.replaceState(null, '', `/#access_token=${tok}&refresh_token=r1&expires_in=3600&type=recovery`);
    a = await load();
    expect(a.consumeRedirect()).toEqual({ kind: 'recovery', error: null });
    expect(a.signedInEmail()).toBe('friend@example.com');
    expect(location.hash).toBe('');

    localStorage.clear();
    history.replaceState(null, '', `/#access_token=${tok}&refresh_token=r1&expires_in=3600&type=magiclink`);
    a = await load();
    expect(a.consumeRedirect()).toEqual({ kind: 'signin', error: null });

    localStorage.clear();
    history.replaceState(null, '', '/#error=access_denied&error_description=Call+555-0100+to+verify+your+account');
    a = await load();
    const r = a.consumeRedirect();
    expect(r.kind).toBeNull();
    expect(typeof r.error).toBe('string');
    isOurs(r.error as string, '555', 'verify your account');
    expect(location.hash).toBe('');
  });

  it('sets a new password with the session, and says so plainly when rate limited', async () => {
    const a = await load();
    answer = () => ({ status: 200, body: session('friend@example.com') });
    await a.signInWithPassword('friend@example.com', 'old pw here');
    const token = await a.accessToken();
    answer = () => ({ status: 200, body: { email: 'friend@example.com' } });
    await a.setPassword('a brand new pw');
    const c = last();
    expect(c.method).toBe('PUT');
    expect(c.url).toBe(`${SUPA}/auth/v1/user`);
    expect(c.body).toMatchObject({ password: 'a brand new pw' });
    expect(c.headers.authorization).toBe(`Bearer ${token}`);

    answer = () => ({ status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } });
    const e = (await a.sendLink('friend@example.com').catch((x: Error) => x)) as Error;
    expect(e).toBeInstanceOf(Error);
    isOurs(e.message, 'rate limit exceeded');
  });

  it('calls the account endpoints with the session, and signs out', async () => {
    const a = await load();
    answer = () => ({ status: 200, body: session('friend@example.com') });
    await a.signInWithPassword('friend@example.com', 'pw pw pw pw');
    const token = await a.accessToken();

    answer = () => ({ status: 200, body: { data: [] } });
    await a.listAccounts();
    let c = last();
    expect([c.method, new URL(c.url).pathname]).toEqual(['GET', '/v1/accounts']);
    expect(c.headers.authorization).toBe(`Bearer ${token}`);

    answer = () => ({ status: 201, body: { data: { id: '00000000-0000-4000-8000-000000000001', name: 'Corner Cafe' } } });
    await a.createAccount('Corner Cafe');
    c = last();
    expect([c.method, new URL(c.url).pathname]).toEqual(['POST', '/v1/accounts']);
    expect(c.body).toEqual({ name: 'Corner Cafe' });

    answer = () => ({ status: 200, body: { data: { account_id: '00000000-0000-4000-8000-000000000001' } } });
    await a.acceptInvite('fwi_abc123');
    c = last();
    expect([c.method, new URL(c.url).pathname]).toEqual(['POST', '/v1/invites/fwi_abc123/accept']);
    expect(c.headers.authorization).toBe(`Bearer ${token}`);

    answer = () => ({ status: 204 });
    await a.signOut();
    c = last();
    expect([c.method, c.url]).toEqual(['POST', `${SUPA}/auth/v1/logout`]);
    expect(a.signedInEmail()).toBeNull();
    expect(await a.accessToken()).toBeNull();
  });
});
