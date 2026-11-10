// The component checks for FW-C-093; run by probes/ui/flow-hero.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope (404 for routes it lacks).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowHero } from '../../packages/web/src/flows/FlowHero';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { RouterProvider } from '../../packages/web/src/shell/router';

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

function wrap(ui: React.ReactNode, path: string) {
  history.replaceState(null, '', path);
  return render(
    <RouterProvider>
      <PrefsProvider>
        <LiveProvider>{ui}</LiveProvider>
      </PrefsProvider>
    </RouterProvider>,
  );
}
const hero = () => screen.findByRole('region', { name: 'Where this flow is' });

describe("each flow's page opens with where that flow is", () => {
  it('links back to all flows and shows the flow by name, its state, dial, reason and five stages', async () => {
    stubFwd();
    wrap(<FlowHero flowKey="neighborhood-activation" />, '/flows/neighborhood-activation');
    const h = await hero();
    const back = within(h).getByRole('link', { name: /All flows/ });
    expect(back.getAttribute('href')).toBe('/');
    await waitFor(() => expect(h.textContent).toMatch(/Neighborhood activation/));
    await waitFor(() => expect(h.textContent).toMatch(/Working/));
    expect(h.textContent).toMatch(/Working · Draft/);
    expect(h.textContent).toMatch(/A cycle is drafting now\./);
    for (const s of ['Find', 'You check', 'Sent', 'Replies']) expect(h.textContent).toContain(s);
  });

  it('shows the flow named in the address, not always the first one', async () => {
    stubFwd();
    wrap(<FlowHero flowKey="paid-ads" />, '/flows/paid-ads');
    const h = await hero();
    await waitFor(() => expect(h.textContent).toMatch(/Paid ads/));
    expect(h.textContent).toMatch(/Waits for its 06:00 run\./);
    expect(h.textContent).not.toMatch(/Neighborhood activation/);
  });

  it('counts the drafts that reached each stage, and never shows a made-up zero for finds', async () => {
    stubFwd();
    wrap(<FlowHero flowKey="neighborhood-activation" />, '/flows/neighborhood-activation');
    const h = await hero();
    await waitFor(() => expect(h.textContent).toMatch(/\b1 to check\b/));
    expect(h.textContent).not.toMatch(/×0|\b0 found\b/);
  });

  it('with fwd unreachable the flow reads Unknown', async () => {
    stubFwd({ down: true });
    wrap(<FlowHero flowKey="neighborhood-activation" />, '/flows/neighborhood-activation');
    const h = await hero();
    await waitFor(() => expect(h.textContent).toMatch(/Unknown/), { timeout: 15000 });
    expect(h.textContent).not.toMatch(/Working/);
  });
});
