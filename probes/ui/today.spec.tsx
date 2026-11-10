// The component checks for FW-C-069; run by probes/ui/today.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { BuildOverview } from '../../packages/web/src/dawn/BuildOverview';
import { DawnLog } from '../../packages/web/src/dawn/DawnLog';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { RouterProvider } from '../../packages/web/src/shell/router';

const NOW = new Date().toISOString();
const HEADLINE = 'Two rows landed and three decisions are waiting on you.';

const status = (over: Record<string, unknown> = {}) => ({
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
  max_concurrent: 1,
  running: 1,
  gates: [],
  next: [],
  flows: [
    flow('neighborhood-activation', 'Neighborhood activation', 'running', 'A cycle is drafting now.'),
    flow('paid-ads', 'Paid ads', 'held', 'Waits for its 06:00 run.'),
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
    if (path === '/v1/status') data = status(sc.status);
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

const wrap = (ui: React.ReactNode) =>
  render(
    <RouterProvider>
      <PrefsProvider>
        <LiveProvider>{ui}</LiveProvider>
      </PrefsProvider>
    </RouterProvider>,
  );
const today = () => screen.findByRole('region', { name: 'Today' });

describe('the home page is a Today summary', () => {
  it('counts drafts ready to send and decisions waiting, each a link to where they are worked', async () => {
    stubFwd();
    wrap(<DawnLog />);
    const t = await today();
    const drafts = await within(t).findByRole('link', { name: /\b2 drafts ready to send\b/i });
    const cards = await within(t).findByRole('link', { name: /\b3 decisions waiting\b/i });
    for (const a of [drafts, cards]) expect(a.getAttribute('href')).toMatch(/^\/(inbox|table|flows)\b/);
  });

  it("shows the open region's progress toward each target, and Unknown when fwd has no measures", async () => {
    stubFwd();
    wrap(<DawnLog />);
    let region = await screen.findByRole('region', { name: 'Region progress' });
    await waitFor(() => expect(region.textContent).toMatch(/Oceanside/));
    expect(region.textContent).toMatch(/\b5 of 12\b/);
    expect(region.textContent).toMatch(/\b8 of 20\b/);
    expect(region.textContent).toMatch(/\b2 of 6\b/);
    expect(region.textContent).toMatch(/\b150 of 400\b/);
    expect(region.textContent).not.toMatch(/Vista/);
    cleanup();
    vi.unstubAllGlobals();
    stubFwd({ measures: null });
    wrap(<DawnLog />);
    region = await screen.findByRole('region', { name: 'Region progress' });
    await waitFor(() => expect(region.textContent).toMatch(/Oceanside/));
    expect(region.textContent).toMatch(/Unknown/);
    expect(region.textContent).not.toMatch(/\b0 of\b/);
  });

  it('lists every flow with its state word and, when held, its reason', async () => {
    stubFwd();
    wrap(<DawnLog />);
    const list = await screen.findByRole('list', { name: 'Flows' });
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBe(2));
    const [a, b] = within(list).getAllByRole('listitem');
    expect(a.textContent).toMatch(/Neighborhood activation/);
    expect(a.textContent).toMatch(/\bRunning\b/);
    expect(b.textContent).toMatch(/Paid ads/);
    expect(b.textContent).toMatch(/\bHeld\b/);
    expect(b.textContent).toMatch(/Waits for its 06:00 run\./);
  });

  it('puts a problem before the Today summary', async () => {
    stubFwd({ status: { kill: { engaged: true, engaged_at: NOW }, paused_by_budget: true } });
    wrap(<DawnLog />);
    const t = await today();
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toMatch(/kill switch/i));
    expect(alert.textContent).toMatch(/budget/i);
    expect(alert.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with fwd unreachable says so and shows Unknown, not zero', async () => {
    stubFwd({ down: true });
    wrap(<DawnLog />);
    await screen.findAllByText(/(could not|couldn't|cannot|can't) reach/i, undefined, { timeout: 15000 });
    const t = await today();
    await waitFor(() => expect(t.textContent).toMatch(/Unknown/));
    expect(t.textContent).not.toMatch(/\b0 drafts?\b|\b0 decisions?\b|\bNo drafts\b|\bNothing is waiting\b/i);
  });

  it('keeps the digest headline as one line and moves the build tracker into BuildOverview', async () => {
    stubFwd();
    wrap(<DawnLog />);
    await today();
    await waitFor(() => expect(screen.getAllByText(HEADLINE).length).toBe(1));
    for (const h of ['Your lanes', 'Every change in flight', /^Landed since/, 'Merged, watching', 'Integrity'])
      expect(screen.queryByRole('heading', { name: h })).toBeNull();
    cleanup();
    wrap(<BuildOverview />);
    expect(await screen.findByRole('heading', { name: 'Your lanes' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /^Landed since/ })).toBeTruthy();
  });
});
