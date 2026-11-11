// The component checks for FW-C-098; run by probes/ui/loop-states.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowHero } from '../../packages/web/src/flows/FlowHero';
import { RegionPath } from '../../packages/web/src/flows/FlowVisuals';
import { flowLoop } from '../../packages/web/src/flows/flowState';
import { RouterProvider } from '../../packages/web/src/shell/router';
import { Gauge } from '../../packages/web/src/ui-kit/flow';
import { LoopProvider } from '../../packages/web/src/ui-kit/loop';

const KEY = 'neighborhood-activation';

const flow = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  name: 'Frequency Saturation Engine',
  enabled: true,
  dial: 'draft',
  tier: 'L1',
  state: 'held',
  gate: 'not_due',
  reason: 'Nothing is due: no scheduled or manual run is waiting.',
  open_asks: 0,
  budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.71, used_turns: 8 },
  merged_into: null,
  ...over,
});
const draft = (id: string, status: string) => ({
  id,
  status,
  to: 'a@example.com',
  subject: 's',
  body: 'b',
  organizer: 'o',
  event_url: 'https://example.com',
  created_at: '2026-11-10T00:00:00Z',
});

function stubFwd(f: Record<string, unknown>) {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^.*\/v1/, '/v1');
    let data: unknown = {};
    if (path === '/v1/supervisor')
      data = { kill_switch: false, paused: false, max_concurrent: 4, running: 0, gates: [], flows: [f], next: [] };
    else if (path === `/v1/supervisor/flows/${KEY}/drafts`)
      data = [draft('d1', 'waiting_for_owner'), draft('d2', 'handed_off')];
    else if (path === '/v1/status')
      data = { version: 'probe', kill: { engaged: false }, open_cards: 0, running_runs: 0, chain: { ok: true, head_seq: 1 } };
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

const hero = () =>
  render(
    <RouterProvider>
      <LiveProvider>
        <LoopProvider>
          <FlowHero flowKey={KEY} />
        </LoopProvider>
      </LiveProvider>
    </RouterProvider>,
  );
const stages = (c: HTMLElement) => [...c.querySelectorAll('.flow-hero .loop-node')];
const links = (c: HTMLElement) => [...c.querySelectorAll('.flow-hero .loop-link')];
const stateOf = (el: Element) => ['working', 'connected', 'waiting', 'broken'].find((s) => el.classList.contains(`loop-${s}`));

describe('every node, line and meter shows its loop state and says what it is', () => {
  it('maps the Supervisor to four states', () => {
    expect(flowLoop(flow({ state: 'running', gate: null }) as never)).toBe('working');
    expect(flowLoop(flow() as never)).toBe('connected');
    expect(flowLoop(flow({ gate: 'flow_disabled', enabled: false }) as never)).toBe('waiting');
    for (const gate of ['no_engine', 'cap_required', 'budget', 'stalled', 'dial_unapproved'])
      expect(flowLoop(flow({ gate }) as never)).toBe('broken');
  });

  it('a running flow lights Find and its line; the rest of the loop keeps flowing', async () => {
    stubFwd(flow({ state: 'running', gate: null, reason: '1 run(s) in flight.' }));
    const { container } = hero();
    await waitFor(() => expect(stages(container)).toHaveLength(5));
    expect(links(container)).toHaveLength(5);
    expect(stateOf(stages(container)[0])).toBe('working');
    expect(stateOf(links(container)[0])).toBe('working');
    expect(links(container).slice(1).every((l) => stateOf(l) === 'connected')).toBe(true);
  });

  it('an idle, healthy flow flows slowly, and a stage waiting on you waits', async () => {
    stubFwd(flow());
    const { container } = hero();
    await waitFor(() => expect(stateOf(stages(container)[2])).toBe('waiting'));
    expect(stateOf(stages(container)[0])).toBe('connected');
    expect(links(container).every((l) => stateOf(l) === 'connected')).toBe(true);
  });

  it('a broken flow shows every line in warning tones', async () => {
    stubFwd(flow({ gate: 'budget', reason: "This week's cap is used up." }));
    const { container } = hero();
    await waitFor(() => expect(links(container)).toHaveLength(5));
    expect(links(container).every((l) => stateOf(l) === 'broken')).toBe(true);
    expect(stateOf(stages(container)[0])).toBe('broken');
  });

  it('clicking a node or a line says what it is; Escape closes it', async () => {
    stubFwd(flow());
    const { container } = hero();
    await waitFor(() => expect(stages(container)).toHaveLength(5));
    fireEvent.click(stages(container)[0]);
    const panel = await screen.findByRole('complementary', { name: 'Find' });
    expect(panel.textContent).toMatch(/Connected/);
    expect(panel.textContent).toMatch(/event listings/);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    fireEvent.keyDown(links(container)[4], { key: 'Enter' });
    expect((await screen.findByRole('complementary', { name: 'Replies to Find' })).textContent).toMatch(/loop/);
  });

  it('a meter in a loop glows, flows and opens on click', async () => {
    const { container } = render(
      <LoopProvider>
        <Gauge
          value={2}
          cap={5}
          label="Spent"
          center={null}
          loop={{ title: 'Spend this period', loop: 'connected', what: 'What the flow spent.' }}
        />
      </LoopProvider>,
    );
    const dial = container.querySelector('.gauge-dial.loop-connected');
    expect(dial).not.toBeNull();
    expect(dial?.querySelector('.loop-line')).not.toBeNull();
    fireEvent.click(dial as Element);
    expect(await screen.findByRole('complementary', { name: 'Spend this period' })).toBeTruthy();
  });

  it('regions and the lines between them carry the state and open on click', async () => {
    const t = (id: string, order: number, status: string) => ({
      id,
      name: id,
      order,
      status,
      progress: status === 'active' ? 0.26 : null,
      population: 1,
      sub_areas: [],
      measures: null,
      targets: {},
      weeks_at_threshold: 0,
    });
    const { container } = render(
      <LoopProvider>
        <RegionPath territories={[t('A', 1, 'active'), t('B', 2, 'waiting'), t('C', 3, 'waiting')] as never} loop="connected" />
      </LoopProvider>,
    );
    const nodes = [...container.querySelectorAll('.flow-node.loop-target')];
    const lines = [...container.querySelectorAll('.region-link')];
    expect(nodes.map(stateOf)).toEqual(['connected', 'waiting', 'waiting']);
    expect(lines).toHaveLength(2);
    fireEvent.click(lines[0]);
    expect((await screen.findByRole('complementary', { name: 'A to B' })).textContent).toMatch(/hand-off/);
  });
});
