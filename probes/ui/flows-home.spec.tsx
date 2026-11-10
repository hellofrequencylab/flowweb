// The component checks for FW-C-091; run by probes/ui/flows-home.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowsHome } from '../../packages/web/src/flows/FlowsHome';
import { BottomNav, TopNav } from '../../packages/web/src/shell/Nav';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { RouterProvider } from '../../packages/web/src/shell/router';
import { routeOf, tabOf } from '../../packages/web/src/shell/routes';

const NOW = new Date().toISOString();

const statusOf = (over: Record<string, unknown> = {}) => ({
  daemon: 'up',
  version: '0.0.0',
  started_at: NOW,
  kill: { engaged: false },
  chain: { ok: true, head_seq: 42, head_hash: 'a'.repeat(64), verified_at: NOW },
  sandbox_level: 'enforced',
  open_cards: 3,
  running_runs: 0,
  spend: { today_usd: 1.5, daily_cap_usd: 20, vendors_reporting: ['a'], estimated: false },
  ...over,
});

const flow = (key: string, name: string, state: string, reason: string) => ({
  key,
  name,
  enabled: true,
  dial: 'draft',
  tier: 'L1',
  state,
  gate: state === 'held' ? 'not_due' : null,
  reason,
  open_asks: 0,
  budget: null,
});

const SUPERVISOR = {
  kill_switch: false,
  paused: false,
  max_concurrent: 4,
  running: 1,
  gates: [],
  next: [],
  flows: [
    flow('neighborhood-activation', 'Neighborhood activation', 'running', 'A cycle is drafting now.'),
    flow('paid-ads', 'Paid ads', 'held', 'Waits for its 06:00 run.'),
    flow('lead-hunts', 'Lead hunts', 'held', 'Nothing is due.'),
  ],
};

const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'founder_email',
  subject: `Note ${id}`,
  body: `Hi Front Porch Gallery, note ${id}.`,
  status: 'waiting_for_owner',
  created_at: NOW,
  ...over,
});

const DRAFTS: Record<string, unknown[]> = {
  'neighborhood-activation': [
    draft('d1'),
    draft('d2', { subject: 'A note for {{venue_name}}', body: 'Hi {{venue_name}}, a template.' }),
    draft('d3', { sent_at: NOW }),
    draft('d4', { status: 'rejected', rejected_at: NOW }),
  ],
  'paid-ads': [draft('d5')],
  'lead-hunts': [],
};

const targets = { hosts_active_28d: 12, events_next_14d: 20, sub_areas_covered_14d: 6, wam: 400 };
const territory = (measures: unknown) => ({
  id: 't_ocean',
  name: 'Oceanside',
  order: 1,
  status: 'active',
  borders: [],
  population: 170000,
  sub_areas: [],
  targets,
  measures,
  progress: measures ? 0.4 : null,
  qualifies: measures ? false : null,
  weeks_at_threshold: 0,
  weeks_below: 0,
  leads: { host: 0, venue: 0, builder: 0, resident: 0 },
});
const activation = (measures: unknown) => ({
  key: 'neighborhood-activation',
  name: 'Neighborhood activation',
  enabled: true,
  opened: ['t_ocean'],
  territories: [
    { ...territory(null), id: 't_vista', name: 'Vista', order: 2, status: 'waiting' },
    territory(measures),
  ],
});

type Scenario = { status?: Record<string, unknown>; measures?: unknown; down?: boolean };

function stubFwd(sc: Scenario = {}) {
  vi.stubGlobal('fetch', async (input: string) => {
    if (sc.down) throw new TypeError('fetch failed');
    const url = String(input);
    const path = url.split('?')[0];
    let data: unknown;
    if (path === '/v1/status') data = statusOf(sc.status);
    else if (path === '/v1/status-reports')
      data = [{ id: 'sr_1', kind: 'daily', created_at: NOW, period_from: NOW, period_to: NOW, body: { headline: HEADLINE } }];
    else if (path === '/v1/ledger/rows' || path === '/v1/runs' || path === '/v1/decision-cards') data = [];
    else if (path === '/v1/supervisor') data = SUPERVISOR;
    else if (path === '/v1/flows/neighborhood-activation')
      data = activation('measures' in sc ? sc.measures : { hosts_active_28d: 5, events_next_14d: 8, sub_areas_covered_14d: 2, wam: 150 });
    else {
      const m = /^\/v1\/supervisor\/flows\/([^/]+)\/drafts$/.exec(path);
      if (m) data = DRAFTS[decodeURIComponent(m[1])] ?? [];
    }
    if (data === undefined)
      return new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), { status: 404 });
    return new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 42 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactNode, path = '/') {
  history.replaceState(null, '', path);
  return render(
    <RouterProvider>
      <PrefsProvider>
        <LiveProvider>{ui}</LiveProvider>
      </PrefsProvider>
    </RouterProvider>,
  );
}
const hrefs = (el: HTMLElement) => within(el).getAllByRole('link').map((a) => a.getAttribute('href'));

describe('the site is built around flows and the Supervisor running them', () => {
  it('the top nav is Flows, Needs you and Under the hood; the phone bar is Flows, Needs you and More', () => {
    stubFwd();
    const top = wrap(<TopNav />);
    const nav = within(top.container).getByRole('navigation', { name: 'Main' });
    expect(hrefs(nav)).toEqual(['/', '/inbox', '/hood']);
    const words = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent ?? '');
    ['Flows', 'Needs you', 'Under the hood'].forEach((w, i) => expect(words[i]).toContain(w));
    for (const old of ['Today', 'Growth', 'Inbox']) expect(words.join(' ')).not.toContain(old);
    top.unmount();
    const bottom = wrap(<BottomNav />);
    expect(hrefs(within(bottom.container).getByRole('navigation', { name: 'Main' }))).toEqual(['/', '/inbox', '/more']);
  });

  it('each flow has its own address under /flows, and old addresses still open a page under the Flows tab', () => {
    expect(routeOf('/flows/neighborhood-activation')).toBe('growth');
    expect(routeOf('/growth')).toBe('growth');
    expect(routeOf('/flows')).toBe('today');
    expect(routeOf('/')).toBe('today');
    for (const p of ['/', '/flows', '/growth', '/flows/paid-ads', '/growth/admin']) expect(tabOf(p), p).toBe('/');
    expect(tabOf('/table')).toBe('/inbox');
    expect(tabOf('/runs')).toBe('/hood');
  });

  it('shows the Supervisor at the centre with how many of its slots are running, and every flow around it as a link to its page', async () => {
    stubFwd();
    wrap(<FlowsHome />);
    const hub = await screen.findByRole('group', { name: /^Supervisor\b/ });
    await waitFor(() => expect(hub.textContent).toMatch(/\b1 of 4 running\b/));
    expect(hub.textContent).toMatch(/Working/);
    const map = await screen.findByRole('list', { name: 'Flows the Supervisor runs' });
    const links = within(map).getAllByRole('link');
    const hrefsOf = links.map((a) => a.getAttribute('href'));
    expect(hrefsOf).toContain('/flows/neighborhood-activation');
    expect(hrefsOf).toContain('/flows/paid-ads');
    expect(hrefsOf).toContain('/flows/lead-hunts');
    expect(map.textContent).toMatch(/Add a flow/);
    const live = links.find((a) => a.getAttribute('href') === '/flows/neighborhood-activation');
    expect(live?.textContent).toMatch(/Neighborhood activation/);
    expect(live?.textContent).toMatch(/Working/);
  });

  it('lists every flow through its five stages, with the reason a held flow is held', async () => {
    stubFwd();
    wrap(<FlowsHome />);
    const list = await screen.findByRole('list', { name: 'Flows' });
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBe(3));
    const [a, b] = within(list).getAllByRole('listitem');
    expect(a.textContent).toMatch(/Neighborhood activation/);
    expect(within(a).getByRole('link').getAttribute('href')).toBe('/flows/neighborhood-activation');
    expect(b.textContent).toMatch(/Paid ads/);
    expect(b.textContent).toMatch(/Waits for its 06:00 run\./);
    for (const s of ['Find', 'Draft', 'You check', 'Sent', 'Replies']) expect(document.body.textContent).toContain(s);
  });

  it('says what needs you: drafts ready to send and decisions waiting, each a link to /inbox', async () => {
    stubFwd();
    wrap(<FlowsHome />);
    const needs = await screen.findByRole('region', { name: 'Needs you' });
    const drafts = await within(needs).findByRole('link', { name: /\b2 drafts ready to send\b/i });
    const cards = await within(needs).findByRole('link', { name: /\b3 decisions waiting\b/i });
    for (const l of [drafts, cards]) expect(l.getAttribute('href')).toBe('/inbox');
    const region = await screen.findByRole('region', { name: 'Region progress' });
    await waitFor(() => expect(region.textContent).toMatch(/\b5 of 12\b/));
  });

  it('with fwd unreachable says so and shows Unknown, never zero', async () => {
    stubFwd({ down: true });
    wrap(<FlowsHome />);
    await screen.findAllByText(/(could not|couldn't|cannot|can't) reach/i, undefined, { timeout: 15000 });
    await waitFor(() => expect(document.body.textContent).toMatch(/Unknown/));
    expect(document.body.textContent).not.toMatch(/\b0 running\b|\b0 drafts?\b|\b0 decisions?\b|Nothing needs you/i);
  });
});
