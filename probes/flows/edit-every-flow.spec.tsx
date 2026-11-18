// The component checks for FW-C-165; run by probes/flows/edit-every-flow.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that replays what a real fwd answered (FW_PROBE_FIXTURE, written by the
// probe): the supervisor, the main flow's view, its targeting, its hunts and its profiles, with the studios
// profile already made. Every other read answers 404 and every write is recorded.
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { ActivationPage } from '../../packages/web/src/flows/ActivationPage';
import { FlowsHome } from '../../packages/web/src/flows/FlowsHome';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { RouterProvider } from '../../packages/web/src/shell/router';

const BASE = 'neighborhood-activation';
const COPY = `/v1/supervisor/flows/${BASE}/copy`;
const FWD = JSON.parse(readFileSync(String(process.env.FW_PROBE_FIXTURE), 'utf8')) as Record<string, unknown>;
type Profile = { slug: string; name: string; copy_key: string | null };
const PROFILES = (FWD[`/v1/flows/${BASE}/profiles`] as { data: Profile[] } | undefined)?.data ?? [];
const writes: { path: string; body: unknown }[] = [];

function stubFwd() {
  writes.length = 0;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0];
    const method = init.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET')
      return FWD[path] ? json(FWD[path]) : json({ error: { code: 'not_found', message: path } }, 404);
    const body = JSON.parse(String(init.body ?? '{}')) as { profile?: string };
    writes.push({ path, body });
    const data = path === COPY ? { key: `${BASE}--${body.profile}`, flow: null } : {};
    return json({ data, as_of: new Date().toISOString(), head_seq: 1 });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactNode, path: string) {
  history.replaceState(null, '', path);
  stubFwd();
  return render(
    <RouterProvider>
      <PrefsProvider>
        <LiveProvider>{ui}</LiveProvider>
      </PrefsProvider>
    </RouterProvider>,
  );
}

describe('every flow can be edited, and a built profile can be switched on', () => {
  it("the main flow's page has the editor for who it looks for and how the note reads", async () => {
    wrap(<ActivationPage />, `/flows/${BASE}`);
    const editor = await screen.findByRole(
      'region',
      { name: 'Who it looks for and how it writes' },
      { timeout: 20000 },
    );
    await waitFor(() => expect(within(editor).getByLabelText(/Who to look for/)).toBeTruthy(), { timeout: 20000 });
    expect(within(editor).getByLabelText(/How the note reads/)).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(editor.textContent).toMatch(/follows its built-in brief until the first two boxes/);
    expect(editor.textContent).not.toMatch(/[–—]/);
  });

  it('the Flows page lists the profiles not made yet, each with a Switch on button', async () => {
    wrap(<FlowsHome />, '/');
    const unmade = PROFILES.filter((p) => !p.copy_key);
    expect(unmade.length).toBeGreaterThan(0);
    for (const p of unmade)
      expect(await screen.findByRole('button', { name: `Switch on ${p.name}` }, { timeout: 20000 })).toBeTruthy();
    const made = PROFILES.find((p) => p.slug === 'studios');
    expect(made?.copy_key).toBe(`${BASE}--studios`);
    expect(screen.queryByRole('button', { name: `Switch on ${made?.name}` })).toBeNull();
  });

  it('pressing Switch on asks for a copy from that profile and links to the new flow', async () => {
    wrap(<FlowsHome />, '/');
    const p = PROFILES.find((x) => x.slug === 'nonprofits') as Profile;
    fireEvent.click(await screen.findByRole('button', { name: `Switch on ${p.name}` }, { timeout: 20000 }));
    await waitFor(() => expect(writes.some((w) => w.path === COPY)).toBe(true));
    expect(writes.filter((w) => w.path === COPY)).toEqual([{ path: COPY, body: { profile: 'nonprofits' } }]);
    const link = await screen.findByRole('link', { name: `Open ${p.name}` });
    expect(link.getAttribute('href')).toBe(`/flows/${BASE}--nonprofits`);
    expect(link.closest('li')?.textContent).toMatch(/It is off, on Draft/);
    expect(writes.every((w) => w.path === COPY)).toBe(true);
  });
});
