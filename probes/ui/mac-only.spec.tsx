// The component checks for FW-C-073; run by probes/ui/mac-only.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub; HOSTED is switched per check.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ hosted: true }));
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
import { EvidencePage } from '../../packages/web/src/evidence/EvidencePage';
import { SettingsPage } from '../../packages/web/src/settings/SettingsPage';
import { KillControl, KillPill } from '../../packages/web/src/shell/KillSwitch';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { Button } from '../../packages/web/src/ui-kit/Button';

const MAC = /Only on your Mac/;

const status = (kill: Record<string, unknown> = { engaged: false }) => ({
  daemon: 'up',
  version: 'x',
  started_at: new Date().toISOString(),
  chain: { ok: true, head_seq: 1, head_hash: '', verified_at: new Date().toISOString() },
  sandbox_level: 'enforced',
  open_cards: 0,
  running_runs: 0,
  kill,
});

type Call = { method: string; url: string };
let calls: Call[] = [];

function stub(kill?: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url) });
    const env = (data: unknown) =>
      new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && url === '/v1/status') return env(status(kill));
    if (method === 'GET' && url === '/v1/hosted/machines') return env([]);
    if (method === 'POST' && url === '/v1/kill-switch') return env({ engaged: true });
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here', details: {} } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const wrap = (node: React.ReactNode) =>
  render(
    <PrefsProvider>
      <LiveProvider>{node}</LiveProvider>
    </PrefsProvider>,
  );

/** The text of the elements that describe this one. */
const description = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

const killPosts = () => calls.filter((c) => c.method === 'POST' && c.url === '/v1/kill-switch');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  mode.hosted = true;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Mac-only actions', () => {
  it('on the site a macOnly button is locked and says why', () => {
    const press = vi.fn();
    render(
      <Button macOnly onClick={press}>
        Approve
      </Button>,
    );
    const b = screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(description(b)).toMatch(MAC);
    fireEvent.click(b);
    expect(press).not.toHaveBeenCalled();
  });

  it('on the Mac a macOnly button is an ordinary button', () => {
    mode.hosted = false;
    const press = vi.fn();
    render(
      <Button macOnly onClick={press}>
        Approve
      </Button>,
    );
    const b = screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(screen.queryByText(MAC)).toBeNull();
    fireEvent.click(b);
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('on the site the kill switch is locked and the top-bar Stop never sends a stop', async () => {
    stub();
    const open = vi.fn();
    wrap(
      <>
        <KillPill onOpen={open} />
        <KillControl />
      </>,
    );
    const big = (await screen.findByRole('button', { name: /Stop everything/ })) as HTMLButtonElement;
    expect(big.disabled).toBe(true);
    expect(description(big)).toMatch(MAC);
    fireEvent.pointerDown(big);
    fireEvent.keyDown(big, { key: 'Enter' });
    const pill = screen.getAllByRole('button').find((b) => b !== big && /Stop/.test(b.textContent ?? ''))!;
    expect(pill).toBeTruthy();
    fireEvent.pointerDown(pill);
    await pause(1900);
    fireEvent.pointerUp(pill);
    fireEvent.click(pill);
    expect(killPosts()).toHaveLength(0);
    expect(open).toHaveBeenCalled();
  });

  it('on the site Release is locked too', async () => {
    stub({ engaged: true, runs_to_halt: 2, runs_halted: 2, keys_revoked: true });
    wrap(<KillControl />);
    const release = (await screen.findByRole('button', { name: /Release/ })) as HTMLButtonElement;
    expect(release.disabled).toBe(true);
    expect(description(release)).toMatch(MAC);
  });

  it('Settings on the site shows the kill switch, locked to the Mac', async () => {
    stub();
    wrap(<SettingsPage pairedAt={new Date().toISOString()} onSignedOut={() => {}} onOpenKill={() => {}} />);
    const big = (await screen.findByRole('button', { name: /Stop everything/ })) as HTMLButtonElement;
    expect(big.disabled).toBe(true);
    expect(description(big)).toMatch(MAC);
  });

  it('on the site the evidence view says the diff is only on your Mac and never asks for it', async () => {
    stub();
    wrap(<EvidencePage id="evb_1" />);
    const change = await screen.findByRole('region', { name: 'The change' });
    await waitFor(() => expect(within(change).getByText(MAC)).toBeTruthy());
    await pause(200);
    expect(calls.filter((c) => /\/diff$/.test(c.url))).toHaveLength(0);
  });

  it('on the Mac the kill switch still stops everything', async () => {
    mode.hosted = false;
    localStorage.setItem('fw.prefs.v1', JSON.stringify({ killMode: 'arm' }));
    stub();
    wrap(<KillControl />);
    const big = (await screen.findByRole('button', { name: /Stop everything/ })) as HTMLButtonElement;
    expect(big.disabled).toBe(false);
    expect(screen.queryByText(MAC)).toBeNull();
    fireEvent.click(big);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm: stop everything/ }));
    await waitFor(() => expect(killPosts()).toHaveLength(1));
  });
});
