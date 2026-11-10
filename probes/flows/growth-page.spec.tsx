// The component checks for FW-C-070; run by probes/flows/growth-page.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { AdminPage, FlowControls } from '../../packages/web/src/flows';
import { RouterProvider } from '../../packages/web/src/shell/router';

const KEY = 'neighborhood-activation';
const NAME = 'Neighborhood activation';

const flow = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  name: NAME,
  enabled: true,
  dial: 'draft',
  tier: 'L1',
  state: 'held',
  gate: 'not_due',
  reason: 'Nothing is due',
  open_asks: 0,
  budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.43, used_turns: 8 },
  ...over,
});
const sup = (flows: unknown[], over: Record<string, unknown> = {}) => ({
  kill_switch: false,
  paused: false,
  max_concurrent: 4,
  running: 0,
  gates: [],
  flows,
  next: [],
  ...over,
});

const adminView = {
  name: NAME,
  thresholds: { hosts_floor: 100, hosts_per_10k: 0.75, hold_weeks: 4 },
  territories: [
    { id: 'north-county-sd', name: 'North County San Diego', status: 'active' },
    { id: 'orange-county', name: 'Orange County', status: 'waiting' },
  ],
  decision: { kind: 'keep_working', territory_id: 'north-county-sd', summary: 'Working North County.' },
  leads: [],
  admin_log: [],
};

function stubFwd(answers: Record<string, unknown>) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = answers[`${method} ${url}`] ?? {};
    const json = { data: body, as_of: new Date().toISOString(), head_seq: 1 };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (node: ReactNode) =>
  render(
    <RouterProvider>
      <LiveProvider>{node}</LiveProvider>
    </RouterProvider>,
  );

describe('the growth page', () => {
  it("puts each flow's switch, Run now, dial and gate word in one row", async () => {
    stubFwd({ 'GET /v1/supervisor': sup([flow(), flow({ key: 'paid-ads', name: 'Paid ads', enabled: false, gate: 'flow_disabled' })]) });
    show(<FlowControls />);
    const row = await screen.findByRole('group', { name: NAME });
    const r = within(row);
    expect(r.getByText('On, nothing due')).toBeTruthy();
    expect(r.getByRole('button', { name: `Turn off ${NAME}` })).toBeTruthy();
    expect(r.getByRole('button', { name: `Run ${NAME} now` })).toBeTruthy();
    expect(r.getByRole('radiogroup', { name: `Dial for ${NAME}` })).toBeTruthy();
    const ads = within(screen.getByRole('group', { name: 'Paid ads' }));
    expect(ads.getByText('Off')).toBeTruthy();
    expect(ads.getByRole('button', { name: 'Turn on Paid ads' })).toBeTruthy();
  });

  it("shows the kill switch as the row's gate word", async () => {
    stubFwd({ 'GET /v1/supervisor': sup([flow({ gate: 'kill_switch' })], { kill_switch: true }) });
    show(<FlowControls />);
    const row = await screen.findByRole('group', { name: NAME });
    expect(within(row).getByText('Stopped by the kill switch')).toBeTruthy();
  });

  it('never shows an unknown spend as zero', async () => {
    const budget = { max_usd: 5, max_turns: 200, period: 'week', spent_usd: null, used_turns: 0 };
    stubFwd({ 'GET /v1/supervisor': sup([flow({ budget })]) });
    show(<FlowControls />);
    const row = await screen.findByRole('group', { name: NAME });
    expect(within(row).getByText(/Unknown/)).toBeTruthy();
    expect(within(row).queryByText(/\$0\.00/)).toBeNull();
  });

  it('shows the admin panels on their own page', async () => {
    stubFwd({ [`GET /v1/flows/${KEY}`]: adminView });
    show(<AdminPage />);
    for (const title of [
      'Upload leads',
      'Upload metrics',
      'Open the next region',
      'Activation targets',
      'Edit raw config',
      'Admin log',
    ])
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
  });
});
