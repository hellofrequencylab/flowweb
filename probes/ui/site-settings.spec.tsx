// The component checks for FW-C-169; run by probes/ui/site-settings.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowCopyPage } from '../../packages/web/src/flows/FlowCopyPage';
import { KevinSettings } from '../../packages/web/src/settings/AiSettings';
import { InterfaceSettings } from '../../packages/web/src/settings/InterfaceSettings';
import { forgetSiteSettings } from '../../packages/web/src/settings/siteSettings';
import { RouterProvider } from '../../packages/web/src/shell/router';

const COPY = 'neighborhood-activation--coaches-guides';
const SECTIONS = ['lead-hunts', 'reply-helper', 'event-intake', 'whats-working', 'paid-ads'];
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', about: 'The most careful answers. The default.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', about: 'Quicker and about half the cost per answer.' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', about: 'The fastest and cheapest, for short questions.' },
];
const settings = (hidden: string[] = []) => ({
  kevin: { model: null, instructions: '' },
  interface: { home: 'today', sections: Object.fromEntries(SECTIONS.map((s) => [s, !hidden.includes(s)])) },
  note: null,
  models: MODELS,
  section_names: SECTIONS,
});
const SUP = {
  kill_switch: false,
  paused: false,
  max_concurrent: 4,
  running: 0,
  gates: [],
  next: [],
  flows: [{ key: COPY, name: 'Coaches and Guides', enabled: true, dial: 'draft', tier: 'L1', state: 'held', gate: 'not_due', reason: 'Nothing is due', open_asks: 0, budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0, used_turns: 0 } }],
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
/** `site` is what GET /v1/site-settings answers; undefined stands for a fwd that has no such route. */
function stubFwd(site: unknown) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const envelope = (data: unknown, status = 200) =>
      new Response(JSON.stringify(status === 200 ? { data, as_of: new Date().toISOString(), head_seq: 1 } : { error: { code: 'not_found', message: 'no such route' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/v1/site-settings') {
      if (site === undefined) return envelope(null, 404);
      if (method === 'GET') return envelope(site);
      const now = site as ReturnType<typeof settings>;
      return envelope({ ...now, kevin: { ...now.kevin, ...body.kevin }, interface: { ...now.interface, ...body.interface, sections: { ...now.interface.sections, ...body.interface?.sections } } });
    }
    if (url === '/v1/supervisor') return envelope(SUP);
    if (/\/(hunts|drafts)$/.test(url)) return envelope([]);
    return envelope({});
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetSiteSettings();
});

const show = (node: ReactNode) =>
  render(
    <RouterProvider>
      <LiveProvider>{node}</LiveProvider>
    </RouterProvider>,
  );
const heading = (name: string) => screen.queryByRole('heading', { name });
const saves = () => calls.filter((c) => c.method === 'POST' && c.url === '/v1/site-settings').map((c) => c.body);

describe('site settings', () => {
  it("saves Kevin's model and standing instructions from Settings", async () => {
    stubFwd(settings());
    show(<KevinSettings />);
    const model = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    expect(model.value).toBe('claude-opus-5-5');
    expect([...model.options].map((o) => o.value)).toEqual(MODELS.map((m) => m.id));
    for (const o of model.options) expect((o.textContent ?? '').length).toBeGreaterThan(o.value.length);
    fireEvent.change(model, { target: { value: 'claude-haiku-5-5' } });
    fireEvent.change(screen.getByLabelText(/Standing instructions/), { target: { value: 'Answer in three lines.' } });
    const kevin = screen.getByRole('region', { name: /^Kevin/ });
    fireEvent.click([...kevin.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement);
    await waitFor(() => expect(saves()).toEqual([{ kevin: { model: 'claude-haiku-5-5', instructions: 'Answer in three lines.' } }]));
    await waitFor(() => expect(kevin.textContent).toMatch(/Saved/));
  });

  it('hides a panel from the Interface switches, and offers no switch for drafts or controls', async () => {
    stubFwd(settings());
    show(<InterfaceSettings />);
    const sw = await screen.findByRole('switch', { name: /Reply helper/ });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    const panel = screen.getByRole('region', { name: /^Interface/ });
    const names = [...panel.querySelectorAll('[role="switch"]')].map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(names.length).toBe(SECTIONS.length);
    expect(names.some((n) => /draft|control/i.test(n))).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(saves()).toEqual([{ interface: { sections: { 'reply-helper': false } } }]));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Reply helper/ }).getAttribute('aria-checked')).toBe('false'));
  });

  it('shows every panel on a flow page by default', async () => {
    stubFwd(settings());
    show(<FlowCopyPage flow={COPY} />);
    expect(await screen.findByRole('heading', { name: 'Lead hunts' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Answer a reply' })).toBeTruthy();
  });

  it('leaves a hidden panel off the flow page and keeps the drafts', async () => {
    stubFwd(settings(['reply-helper']));
    show(<FlowCopyPage flow={COPY} />);
    expect(await screen.findByRole('heading', { name: 'Lead hunts' })).toBeTruthy();
    await waitFor(() => expect(heading('Answer a reply')).toBeNull());
    expect(document.querySelector('.inbox-panel')).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.url === '/v1/site-settings')).toBe(true);
  });

  it('shows everything when the machine has no site settings yet', async () => {
    stubFwd(undefined);
    show(<FlowCopyPage flow={COPY} />);
    expect(await screen.findByRole('heading', { name: 'Lead hunts' })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/site-settings')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Answer a reply' })).toBeTruthy();
  });
});
