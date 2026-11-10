// The component checks for FW-C-074; run by probes/ui/settings-tidy.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub; HOSTED is switched per check.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ hosted: false }));
vi.mock('../../packages/web/src/hosted/auth', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    get HOSTED() {
      return mode.hosted;
    },
    accessToken: async () => null,
    signedInEmail: () => 'owner@example.com',
  };
});

import { LiveProvider } from '../../packages/web/src/api/live';
import { SettingsPage } from '../../packages/web/src/settings/SettingsPage';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';

function stub() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const env = (data: unknown) =>
      new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && url === '/v1/status')
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
    if (method === 'GET' && url === '/v1/hosted/machines') return env([]);
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
        <SettingsPage pairedAt={new Date().toISOString()} onSignedOut={() => {}} onOpenKill={() => {}} />
      </LiveProvider>
    </PrefsProvider>,
  );

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
const at = (list: string[], re: RegExp) => list.findIndex((t) => re.test(t));
/** Index of an element in document order among all the given elements. */
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  mode.hosted = false;
  localStorage.clear();
  stub();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings order and the Look and feel fold', () => {
  it('on the Mac: kill switch first, then the session, then Look and feel', async () => {
    show();
    await screen.findByRole('heading', { level: 2, name: /^Session/ });
    const h = headings();
    expect(at(h, /^Kill switch/)).toBe(0);
    expect(at(h, /^Session/)).toBeGreaterThan(0);
    const look = screen.getByRole('button', { name: /Look and feel/ });
    expect(before(screen.getByRole('heading', { level: 2, name: /^Session/ }), look)).toBe(true);
  });

  it('on the site: kill switch, then sign-ins, then machines, then the session', async () => {
    mode.hosted = true;
    show();
    await screen.findByRole('heading', { level: 2, name: /^Machines/ });
    const h = headings();
    const kill = at(h, /^Kill switch/);
    const accounts = at(h, /^Accounts and API keys/);
    const machines = at(h, /^Machines/);
    const session = at(h, /^Session/);
    expect(kill).toBe(0);
    expect(accounts).toBeGreaterThan(kill);
    expect(machines).toBeGreaterThan(accounts);
    expect(session).toBeGreaterThan(machines);
  });

  it('Calm mode is in view without opening anything, and works', async () => {
    show();
    const look = await screen.findByRole('button', { name: /Look and feel/ });
    expect(look.getAttribute('aria-expanded')).toBe('false');
    const calm = screen.getByRole('switch', { name: /Calm mode/ });
    fireEvent.click(calm);
    await waitFor(() => expect(document.documentElement.getAttribute('data-calm')).toBe('on'));
  });

  it('Look and feel is closed at first and hides the other display preferences', async () => {
    show();
    const look = await screen.findByRole('button', { name: /Look and feel/ });
    expect(look.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('switch', { name: /^Rewards/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Single-key shortcuts/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Dark' })).toBeNull();
  });

  it('opened, Look and feel holds every other display preference', async () => {
    show();
    const look = await screen.findByRole('button', { name: /Look and feel/ });
    fireEvent.click(look);
    expect(look.getAttribute('aria-expanded')).toBe('true');
    for (const name of [/^Rewards/, /All signed off/, /Landed and proven/, /Single-key shortcuts/])
      expect(screen.getByRole('switch', { name })).toBeTruthy();
    for (const name of ['Follow system', 'Dark', 'Compact', 'Arm, then confirm'])
      expect(screen.getByRole('radio', { name })).toBeTruthy();
  });

  it('Policy is still shown, locked, without opening anything', async () => {
    show();
    expect(await screen.findByRole('heading', { level: 2, name: /^Policy/ })).toBeTruthy();
    expect(screen.getByText(/Read-only here/)).toBeTruthy();
  });
});
