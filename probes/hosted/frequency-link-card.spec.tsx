// The component checks for FW-C-120; run by probes/hosted/frequency-link-card.mjs (not on its own). Tier 0.
// The hosted /v1/plugin (row FW-C-111) is stood in by a fetch stub. hosted/auth.ts reads its settings and the
// saved session when it loads, so both are put in place before any import.
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

import { LiveProvider } from '../../packages/web/src/api/live';
import { FrequencyLinkPanel } from '../../packages/web/src/hosted/FrequencyLink';
import { SettingsPage } from '../../packages/web/src/settings/SettingsPage';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';

const ACC = '00000000-0000-4000-8000-000000000001';
const LINK = '00000000-0000-4000-8000-0000000000d4';
const SECRET = `fwl_${'ab'.repeat(32)}`;
const SECRET2 = `fwl_${'cd'.repeat(32)}`;

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let role = 'owner';
let links: Record<string, unknown>[] = [];
let refuse: { status: number; message: string } | null = null;

const env = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, as_of: new Date().toISOString() }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const linked = (status = 'active') => ({
  id: LINK,
  account_id: ACC,
  space_id: 'house',
  house: true,
  status,
  created_at: '2026-11-11T00:00:00Z',
  rotated_at: null,
  last_event_at: '2026-11-11T01:00:00Z',
});

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
    if (method === 'GET' && p === '/v1/accounts') return env([{ id: ACC, name: 'Corner Cafe', role, flows: null }]);
    if (method === 'GET' && p === '/v1/plugin/links') return env(links);
    if (method === 'POST' && p === '/v1/plugin/links') {
      if (refuse)
        return new Response(JSON.stringify({ error: { code: 'conflict', message: refuse.message, details: {} } }), {
          status: refuse.status,
          headers: { 'content-type': 'application/json' },
        });
      const b = body as { space_id: string; house: boolean };
      links = [{ ...linked(), space_id: b.space_id, house: b.house, last_event_at: null }];
      return env({ id: LINK, space_id: b.space_id, secret: SECRET, note: 'shown once' }, 201);
    }
    if (method === 'POST' && p === `/v1/plugin/links/${LINK}/rotate`) return env({ id: LINK, secret: SECRET2 });
    if (method === 'PATCH' && p === `/v1/plugin/links/${LINK}`) {
      const s = (body as { status: string }).status;
      links = links.map((l) => ({ ...l, status: s }));
      return env({ id: LINK, status: s });
    }
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

const wrap = (el: React.ReactNode) =>
  render(
    <PrefsProvider>
      <LiveProvider>{el}</LiveProvider>
    </PrefsProvider>,
  );
const show = () => wrap(<FrequencyLinkPanel />);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  calls = [];
  role = 'owner';
  links = [];
  refuse = null;
  stub();
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Link to Frequency, in Settings on the site', () => {
  it('an owner links the house and sees the id and secret once, naming where they go', async () => {
    show();
    const box = await screen.findByRole('textbox', { name: /Frequency Space id/ });
    fireEvent.change(box, { target: { value: ' house ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /house/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Link to Frequency/ }));
    const shown = await screen.findByRole('status', { name: /New link secret/ });
    expect(within(shown).getByText(SECRET)).toBeTruthy();
    expect(within(shown).getByText(LINK)).toBeTruthy();
    expect(shown.textContent).toMatch(/FLOWWEB_HOUSE_LINK_ID/);
    expect(shown.textContent).toMatch(/FLOWWEB_HOUSE_LINK_SECRET/);
    expect(within(shown).getByRole('button', { name: /Copy link secret/ })).toBeTruthy();
    const [post] = sent('POST', '/v1/plugin/links');
    expect(post?.body).toEqual({ account: ACC, space_id: 'house', house: true });
    expect(post?.headers.authorization).toBe(`Bearer ${ME.token}`);
    fireEvent.click(within(shown).getByRole('button', { name: /I copied them/ }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
    expect(await screen.findByText(/Linked to Space/)).toBeTruthy();
  });

  it('a Space id Frequency would refuse cannot be sent', async () => {
    show();
    const box = await screen.findByRole('textbox', { name: /Frequency Space id/ });
    fireEvent.change(box, { target: { value: 'not a space!' } });
    const btn = screen.getByRole('button', { name: /^Link to Frequency/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(sent('POST', '/v1/plugin/links')).toHaveLength(0);
  });

  it('a refusal from the server is shown in its own words', async () => {
    refuse = { status: 409, message: 'that Space is already linked to a business' };
    show();
    fireEvent.change(await screen.findByRole('textbox', { name: /Frequency Space id/ }), { target: { value: 'sp1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Link to Frequency/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already linked/);
    expect(screen.queryByRole('status', { name: /New link secret/ })).toBeNull();
  });

  it('a linked business shows its Space and last event, and pauses and resumes', async () => {
    links = [linked()];
    show();
    expect(await screen.findByText(/Linked to Space/)).toBeTruthy();
    expect(screen.getByText('house')).toBeTruthy();
    expect(screen.getByText(/Last heard from Frequency/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Frequency Space id/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Pause/ }));
    await waitFor(() => expect(sent('PATCH', `/v1/plugin/links/${LINK}`)).toHaveLength(1));
    expect(sent('PATCH', `/v1/plugin/links/${LINK}`)[0]?.body).toEqual({ status: 'paused' });
    fireEvent.click(await screen.findByRole('button', { name: /^Resume/ }));
    await waitFor(() => expect(sent('PATCH', `/v1/plugin/links/${LINK}`)).toHaveLength(2));
    expect(sent('PATCH', `/v1/plugin/links/${LINK}`)[1]?.body).toEqual({ status: 'active' });
  });

  it('a new secret is made only after confirming, and is shown once', async () => {
    links = [linked()];
    show();
    vi.stubGlobal('confirm', () => false);
    fireEvent.click(await screen.findByRole('button', { name: /Make a new secret/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent('POST', `/v1/plugin/links/${LINK}/rotate`)).toHaveLength(0);
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(screen.getByRole('button', { name: /Make a new secret/ }));
    const shown = await screen.findByRole('status', { name: /New link secret/ });
    expect(within(shown).getByText(SECRET2)).toBeTruthy();
  });

  it('unlinking asks first, then sends revoked and offers a fresh link', async () => {
    links = [linked()];
    show();
    vi.stubGlobal('confirm', () => false);
    fireEvent.click(await screen.findByRole('button', { name: /^Unlink/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent('PATCH', `/v1/plugin/links/${LINK}`)).toHaveLength(0);
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(screen.getByRole('button', { name: /^Unlink/ }));
    await waitFor(() => expect(sent('PATCH', `/v1/plugin/links/${LINK}`)[0]?.body).toEqual({ status: 'revoked' }));
    expect(await screen.findByRole('textbox', { name: /Frequency Space id/ })).toBeTruthy();
  });

  it('a helper sees the link but no controls, and Settings on the site shows the section', async () => {
    role = 'helper';
    links = [linked()];
    show();
    expect(await screen.findByText(/Linked to Space/)).toBeTruthy();
    expect(screen.getByText(/Only an owner or admin/)).toBeTruthy();
    for (const name of [/^Pause/, /Make a new secret/, /^Unlink/]) expect(screen.queryByRole('button', { name })).toBeNull();
    cleanup();
    links = [];
    show();
    expect(await screen.findByText(/Not linked yet/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Frequency Space id/ })).toBeNull();
    cleanup();
    wrap(<SettingsPage pairedAt={new Date().toISOString()} onSignedOut={() => {}} onOpenKill={() => {}} />);
    expect(await screen.findByRole('heading', { level: 2, name: /^Link to Frequency/ })).toBeTruthy();
  });
});
