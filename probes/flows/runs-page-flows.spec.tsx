// The component checks for FW-C-065; run by probes/flows/runs-page-flows.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope, filtering status-reports by
// kind as fwd does.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { RunsPage } from '../../packages/web/src/runs/RunsPage';
import { RouterProvider } from '../../packages/web/src/shell/router';

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const KEY = 'neighborhood-activation';

const cycle = (id: string, startH: number, body: Record<string, unknown>) => ({
  id,
  reporter_agent_id: 'agt_lead',
  project_id: 'prj_1',
  kind: 'run',
  period_from: ago(startH),
  period_to: ago(startH - 0.01),
  data_as_of: ago(startH - 0.01),
  created_at: ago(startH - 0.01),
  body: { stream_id: 'stm_1', flow: KEY, fire_id: `stm_1:${id}`, adapter: 'codex', ...body },
});

const REPORTS = [
  cycle('rpt_drafted', 2, {
    outcome: 'drafted',
    drafts: 4,
    hunts: [{ id: 'hnt_1', found: 3, drafted: 3, blocked: 0, not_public: 0 }],
  }),
  cycle('rpt_dry', 5, { outcome: 'dry', drafts: 0 }),
  cycle('rpt_failed', 30, { outcome: 'failed', drafts: 0, reason: 'adapter ended failed: codex was not signed in' }),
  {
    id: 'rpt_daily',
    reporter_agent_id: 'agt_chiefofstaff',
    project_id: 'prj_1',
    kind: 'daily',
    period_from: ago(25),
    period_to: ago(1),
    data_as_of: ago(1),
    created_at: ago(1),
    body: { headline: '12 events: 2 rows added', done: [], blocked: [] },
  },
];

const RUN = {
  id: 'run_agent1',
  work_order_id: 'wo_1',
  project_id: 'prj_1',
  ledger_row_id: 'FW-C-900',
  row_code: 'FW-C-900',
  agent_id: 'agt_w',
  agent_role: 'worker',
  attempt: 1,
  adapter_name: 'claude',
  adapter_vendor: 'anthropic',
  adapter_version: null,
  status: 'succeeded',
  exit_code: 0,
  failure_class: null,
  tokens_in: 0,
  tokens_out: 0,
  sandbox_level: 'enforced',
  artifact_verified: true,
  queued_at: ago(3),
  started_at: ago(3),
  ended_at: ago(2.5),
  last_heartbeat_at: ago(2.5),
  cost_usd: 0.12,
};

function stubFwd(runs: unknown[]) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, 'http://fwd.test');
    let data: unknown = {};
    if ((init.method ?? 'GET') === 'GET' && u.pathname === '/v1/runs') data = runs;
    else if (u.pathname === '/v1/status-reports') {
      const kind = u.searchParams.get('kind');
      data = REPORTS.filter((r) => !kind || r.kind === kind);
    } else if (u.pathname.startsWith('/v1/')) data = [];
    return new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <RouterProvider>
      <LiveProvider>
        <RunsPage />
      </LiveProvider>
    </RouterProvider>,
  );

describe('Runs page with flow runs', () => {
  it('counts flow runs in the last 24 hours', async () => {
    stubFwd([]);
    show();
    await screen.findByRole('region', { name: 'Flow runs' });
    const day = screen.getByRole('region', { name: 'Last 24 hours' });
    expect(day.textContent).not.toMatch(/No runs started/);
    expect(day.textContent).toMatch(/(^|\D)3 runs\b/);
  });

  it('lists each flow cycle and the digest with what it did', async () => {
    stubFwd([]);
    show();
    const region = await screen.findByRole('region', { name: 'Flow runs' });
    const rows = within(region)
      .getAllByRole('row')
      .map((r) => r.textContent ?? '');
    const rowWith = (re: RegExp) => rows.find((t) => re.test(t)) ?? '';
    expect(rows.filter((t) => /neighborhood.activation/i.test(t)).length).toBe(3);
    expect(rowWith(/Drafted/)).toMatch(/4 drafts/);
    expect(rowWith(/Drafted/)).toMatch(/3 found/);
    expect(rowWith(/Nothing drafted/)).toMatch(/neighborhood.activation/i);
    expect(rowWith(/Failed/)).toMatch(/codex was not signed in/);
    expect(rowWith(/Published/)).toMatch(/digest/i);
  });

  it('includes flow runs in the summary count', async () => {
    stubFwd([]);
    show();
    await screen.findByRole('region', { name: 'Flow runs' });
    const donut = screen.getAllByRole('img').find((e) => /^\d+ runs/.test(e.getAttribute('aria-label') ?? ''));
    expect(donut?.getAttribute('aria-label')).toMatch(/^4 runs/);
  });

  it('still shows agent runs', async () => {
    stubFwd([RUN]);
    show();
    await screen.findByRole('region', { name: 'Flow runs' });
    const link = await screen.findByRole('link', { name: 'run_agent1' });
    expect(link.getAttribute('href')).toBe('/runs/run_agent1');
    const donut = screen.getAllByRole('img').find((e) => /^\d+ runs/.test(e.getAttribute('aria-label') ?? ''));
    expect(donut?.getAttribute('aria-label')).toMatch(/^5 runs/);
  });
});
