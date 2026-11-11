// The Settings checks for FW-C-118; run by probes/flows/funnels-switch.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub answering GET /v1/supervisor with funnels_live.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FunnelsSwitch } from '../../packages/web/src/settings/FunnelsSwitch';

const now = new Date().toISOString();
let funnels: unknown = { live: false, source: 'env', setting: null, env_off: true };
let posts: { url: string; body: unknown }[] = [];
beforeEach(() => {
  posts = [];
  funnels = { live: false, source: 'env', setting: null, env_off: true };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const env = (data: unknown) =>
      new Response(JSON.stringify({ data, as_of: now, head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      funnels = { live: body?.live, source: 'setting', setting: body?.live, env_off: true };
      return env({ changed: true });
    }
    if (url === '/v1/supervisor')
      return env({ kill_switch: false, paused: false, max_concurrent: 1, running: 0, gates: [], next: [], flows: [], funnels_live: funnels });
    return env({});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <LiveProvider>
      <FunnelsSwitch />
    </LiveProvider>,
  );
const group = () => screen.getByRole('group', { name: /Frequency funnel pages live/ });
const radio = (name: string) => within(group()).getByRole('radio', { name }) as HTMLInputElement;

describe('Frequency funnel pages live (FW-C-118)', () => {
  it('shows the switch, its one line, and where the current value comes from', async () => {
    show();
    await waitFor(() => group());
    expect(radio('On')).toBeTruthy();
    expect(radio('Off')).toBeTruthy();
    expect(radio('Flow default').checked).toBe(true);
    expect(document.body.textContent).toMatch(
      "Off: drafts link to /create-a-space until Frequency's /start/host, /for/<niche> and /launch pages are live.",
    );
    await waitFor(() => expect(group().textContent).toMatch(/FW_FUNNELS_LIVE/));
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it('turning it on posts only { live: true } and then shows On', async () => {
    show();
    await waitFor(() => group());
    fireEvent.click(radio('On'));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe('/v1/supervisor/funnels-live');
    expect(posts[0].body).toEqual({ live: true });
    await waitFor(() => expect(radio('On').checked).toBe(true));
  });

  it('Off and Flow default post false and null', async () => {
    funnels = { live: true, source: 'setting', setting: true, env_off: false };
    show();
    await waitFor(() => expect(radio('On').checked).toBe(true));
    fireEvent.click(radio('Off'));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].body).toEqual({ live: false });
    await waitFor(() => expect(radio('Off').checked).toBe(true));
    fireEvent.click(radio('Flow default'));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1].body).toEqual({ live: null });
  });
});
