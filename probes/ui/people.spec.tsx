// The component checks for FW-C-088; run by probes/ui/people.mjs (not on its own). Tier 0.
// The hosted /v1 is stood in by a fetch stub. hosted/auth.ts reads its settings and the saved session when it
// loads, so both are put in place before any import.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ME = vi.hoisted(() => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sub = '00000000-0000-4000-8000-0000000000a1';
  const email = 'me@example.com';
  const token = `${b64({ alg: 'none' })}.${b64({ sub, email, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  vi.stubEnv('VITE_FW_HOSTED', '1');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supa.example');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-for-tests');
  localStorage.setItem(
    'fw.hosted.session',
    JSON.stringify({ access_token: token, refresh_token: 'r1', expires_at: Math.floor(Date.now() / 1000) + 86400, email }),
  );
  return { sub, email, token };
});

import { api } from '../../packages/web/src/api/client';
import { LiveProvider } from '../../packages/web/src/api/live';
import { PeoplePanel } from '../../packages/web/src/hosted/People';
import * as webRoles from '../../packages/web/src/hosted/roles';
import { SettingsPage } from '../../packages/web/src/settings/SettingsPage';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
// @ts-expect-error plain JS module without types
import * as serverRoles from '../../hosted/server/accounts.mjs';

const ACC = '00000000-0000-4000-8000-000000000001';
const ACC2 = '00000000-0000-4000-8000-000000000002';
const HELPER = '00000000-0000-4000-8000-0000000000b2';
const INV = '00000000-0000-4000-8000-0000000000c3';
const LINK_TOKEN = `fwi_${'0'.repeat(32)}`;

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let accounts: { id: string; name: string; role: string; flows: string[] | null }[] = [];

const env = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: null, next_cursor: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function members(acc: string) {
  const mine = accounts.find((a) => a.id === acc);
  return {
    role: mine?.role ?? null,
    members: [
      { user_id: ME.sub, email: ME.email, role: mine?.role ?? 'owner', flows: null, added_at: '2026-11-01T00:00:00Z' },
      { user_id: HELPER, email: 'helper@example.com', role: 'helper', flows: null, added_at: '2026-11-02T00:00:00Z' },
    ],
    invites:
      mine?.role === 'owner' || mine?.role === 'admin'
        ? [{ id: INV, email: 'later@example.com', role: 'viewer', flows: null, created_at: '2026-11-03T00:00:00Z', expires_at: '2026-11-17T00:00:00Z' }]
        : [],
  };
}

function stub() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const u = new URL(String(input), location.origin);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = init.body;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    } catch {
      /* not json */
    }
    calls.push({ method, path: u.pathname, body, headers });
    const p = u.pathname;
    if (method === 'GET' && p === '/v1/accounts') return env(accounts);
    if (method === 'POST' && p === '/v1/accounts') return env({ id: ACC, name: (body as { name: string }).name }, 201);
    const m = p.match(/^\/v1\/accounts\/([0-9a-f-]{36})\/members$/);
    if (method === 'GET' && m) return env(members(m[1]!));
    if (method === 'POST' && /\/invites$/.test(p)) {
      const b = body as { role: string; email: string | null; flows: string[] | null };
      return env({ token: LINK_TOKEN, url: `${location.origin}/join/${LINK_TOKEN}`, ...b }, 201);
    }
    if (method === 'PATCH' && /\/members\/[0-9a-f-]{36}$/.test(p)) return env({ ok: true });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (method === 'GET' && p === '/v1/supervisor')
      return env({
        kill_switch: false,
        paused: false,
        max_concurrent: 1,
        running: 0,
        gates: [],
        next: [],
        flows: [
          { key: 'paid-ads', name: 'Paid ads' },
          { key: 'neighborhood-activation', name: 'Neighborhood activation' },
        ],
      });
    if (method === 'GET' && p === '/v1/hosted/machines') return env([]);
    if (method === 'GET' && p === '/v1/status')
      return env({
        daemon: 'up',
        version: 'x',
        started_at: new Date().toISOString(),
        chain: { ok: true, head_seq: 1, head_hash: '', verified_at: new Date().toISOString() },
        sandbox_level: 'enforced',
        open_cards: 0,
        running_runs: 0,
        kill: { engaged: false },
      });
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here', details: {} } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const show = () =>
  render(
    <PrefsProvider>
      <LiveProvider>
        <PeoplePanel />
      </LiveProvider>
    </PrefsProvider>,
  );
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  calls = [];
  accounts = [{ id: ACC, name: 'Corner Cafe', role: 'owner', flows: null }];
  stub();
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('People: who shares a business, and in what role', () => {
  it('lists the members and open invites, with each role named', async () => {
    show();
    expect(await screen.findByRole('heading', { level: 2, name: /^People/ })).toBeTruthy();
    const list = await screen.findByRole('list', { name: /Members/ });
    expect(within(list).getByText('helper@example.com')).toBeTruthy();
    expect(within(list).getByText(ME.email)).toBeTruthy();
    expect(await screen.findByText('later@example.com')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /^Business/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: `Role for ${ME.email}` })).toBeNull();
  });

  it('an owner makes an invite link for one flow, and the link can be copied', async () => {
    show();
    const as = await screen.findByRole('combobox', { name: /^Invite as/ });
    fireEvent.change(as, { target: { value: 'viewer' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Email/ }), { target: { value: 'Pal@Example.com ' } });
    const access = await screen.findByRole('combobox', { name: /^Access/ });
    await waitFor(() => expect(within(access).getByRole('option', { name: /Paid ads/ })).toBeTruthy());
    fireEvent.change(access, { target: { value: 'paid-ads' } });
    fireEvent.click(screen.getByRole('button', { name: /Make invite link/ }));
    expect(await screen.findByText(new RegExp(`/join/${LINK_TOKEN}`))).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy link/ })).toBeTruthy();
    const [post] = sent('POST', `/v1/accounts/${ACC}/invites`);
    expect(post?.body).toEqual({ role: 'viewer', email: 'pal@example.com', flows: ['paid-ads'] });
    expect(post?.headers.authorization).toBe(`Bearer ${ME.token}`);
  });

  it('an admin invite is always for the whole business, and the email is optional', async () => {
    show();
    fireEvent.change(await screen.findByRole('combobox', { name: /^Invite as/ }), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Make invite link/ }));
    await screen.findByText(new RegExp(`/join/${LINK_TOKEN}`));
    expect(sent('POST', `/v1/accounts/${ACC}/invites`)[0]?.body).toEqual({ role: 'admin', email: null, flows: null });
  });

  it('an owner changes a role, removes someone after confirming, and cancels an invite', async () => {
    show();
    const role = await screen.findByRole('combobox', { name: 'Role for helper@example.com' });
    fireEvent.change(role, { target: { value: 'viewer' } });
    await waitFor(() => expect(sent('PATCH', `/v1/accounts/${ACC}/members/${HELPER}`)).toHaveLength(1));
    expect(sent('PATCH', `/v1/accounts/${ACC}/members/${HELPER}`)[0]?.body).toMatchObject({ role: 'viewer' });

    vi.stubGlobal('confirm', () => false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove helper@example.com' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent('DELETE', `/v1/accounts/${ACC}/members/${HELPER}`)).toHaveLength(0);
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove helper@example.com' }));
    await waitFor(() => expect(sent('DELETE', `/v1/accounts/${ACC}/members/${HELPER}`)).toHaveLength(1));

    fireEvent.click(await screen.findByRole('button', { name: /Cancel invite/ }));
    await waitFor(() => expect(sent('DELETE', `/v1/accounts/${ACC}/invites/${INV}`)).toHaveLength(1));
  });

  it('a viewer sees the people but no controls, and can leave', async () => {
    accounts = [{ id: ACC, name: 'Corner Cafe', role: 'viewer', flows: null }];
    show();
    await screen.findByText('helper@example.com');
    expect(screen.queryByRole('button', { name: /Make invite link/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^Role for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Corner Cafe' }));
    await waitFor(() => expect(sent('DELETE', `/v1/accounts/${ACC}/members/${ME.sub}`)).toHaveLength(1));
  });

  it('a login with no business can make one', async () => {
    accounts = [];
    show();
    fireEvent.change(await screen.findByRole('textbox', { name: /^Business name/ }), { target: { value: 'Corner Cafe' } });
    fireEvent.click(screen.getByRole('button', { name: /Make business/ }));
    await waitFor(() => expect(sent('POST', '/v1/accounts')).toHaveLength(1));
    expect(sent('POST', '/v1/accounts')[0]?.body).toEqual({ name: 'Corner Cafe' });
  });

  it('the web role table agrees with the server one for every role and action', () => {
    expect([...webRoles.ROLES]).toEqual([...serverRoles.ROLES]);
    for (const role of serverRoles.ROLES as string[])
      for (const action of ['delete', 'members', 'machines', 'rename', 'control', 'drafts'])
        expect([role, action, webRoles.can(role, action)]).toEqual([role, action, serverRoles.can(role, action)]);
  });

  it('on the site, People sits after Machines and before the session', async () => {
    render(
      <PrefsProvider>
        <LiveProvider>
          <SettingsPage pairedAt={new Date().toISOString()} onSignedOut={() => {}} onOpenKill={() => {}} />
        </LiveProvider>
      </PrefsProvider>,
    );
    await screen.findByRole('heading', { level: 2, name: /^People/ });
    const h = screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent ?? '');
    const at = (re: RegExp) => h.findIndex((t) => re.test(t));
    expect(at(/^People/)).toBeGreaterThan(at(/^Machines/));
    expect(at(/^Session/)).toBeGreaterThan(at(/^People/));
  });

  it('with two businesses, the one chosen is the one every later call is about', async () => {
    accounts = [
      { id: ACC, name: 'Corner Cafe', role: 'owner', flows: null },
      { id: ACC2, name: 'Night Market', role: 'helper', flows: ['paid-ads'] },
    ];
    show();
    const pick = await screen.findByRole('combobox', { name: /^Business/ });
    expect(within(pick).getByRole('option', { name: /Night Market/ })).toBeTruthy();
    fireEvent.change(pick, { target: { value: ACC2 } });
    await waitFor(() => expect(sent('GET', `/v1/accounts/${ACC2}/members`).length).toBeGreaterThan(0));
    expect(sent('GET', `/v1/accounts/${ACC2}/members`).at(-1)?.headers['x-fw-account']).toBe(ACC2);
    await api.machines();
    expect(sent('GET', '/v1/hosted/machines').at(-1)?.headers['x-fw-account']).toBe(ACC2);
    expect(await screen.findByRole('button', { name: 'Leave Night Market' })).toBeTruthy();
  });
});
