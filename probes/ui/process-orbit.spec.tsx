// The component checks for FW-C-099; run by probes/ui/process-orbit.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowHero } from '../../packages/web/src/flows/FlowHero';
import { learningRing, regionRing, spendRing } from '../../packages/web/src/flows/processes';
import { AccentPicker } from '../../packages/web/src/shell/AccentPicker';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { RouterProvider } from '../../packages/web/src/shell/router';
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
const review = (state: string) => ({
  flow: KEY,
  state,
  at: '2026-11-10T06:00:00Z',
  week: '2026-W45',
  min_sent: 8,
  sample_ok: state === 'ready',
  totals: {},
  dimensions: [],
  learnings: state === 'ready' ? ['Library listings reply more.'] : [],
});
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
const regions = [t('North', 1, 'upkeep'), t('Coast', 2, 'active'), t('Inland', 3, 'waiting')];

function stubFwd(f: Record<string, unknown>, withReview = true) {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^.*\/v1/, '/v1');
    let data: unknown = {};
    if (path === '/v1/supervisor')
      data = { kill_switch: false, paused: false, max_concurrent: 4, running: 0, gates: [], flows: [f], next: [] };
    else if (path === `/v1/supervisor/flows/${KEY}/drafts`) data = [];
    else if (path === `/v1/flows/${KEY}/review/summary`) {
      if (!withReview) return new Response('{}', { status: 503 });
      data = review('ready');
    } else if (path.startsWith('/v1/flows/') && !path.includes('/review'))
      data = { key: KEY, name: 'Neighborhood activation', territories: regions, budget: f.budget };
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
const stateOf = (el: Element | null | undefined) =>
  el ? ['working', 'connected', 'waiting', 'broken'].find((s) => el.classList.contains(`loop-${s}`)) : undefined;

describe("a flow's other processes show as rings, each with its state", () => {
  it('learning follows the weekly review, and an unanswered read waits and says Unknown', () => {
    const ready = learningRing('connected', review('ready') as never);
    expect(ready.nodes?.map((n) => n.loop)).toEqual(['connected', 'connected', 'connected', 'connected']);
    expect(learningRing('working', review('ready') as never).nodes?.[3].loop).toBe('working');
    const thin = learningRing('connected', review('thin') as never);
    expect(thin.nodes?.slice(1).every((n) => n.loop === 'waiting')).toBe(true);
    const unknown = learningRing('connected', null);
    expect(unknown.info.loop).toBe('waiting');
    expect(unknown.info.why).toMatch(/Unknown/);
    expect(learningRing('broken', review('ready') as never).info.loop).toBe('broken');
  });

  it('regions carry the flow state once reached, and spend breaks at the cap', () => {
    const r = regionRing('working', regions as never);
    expect(r?.nodes?.map((n) => n.loop)).toEqual(['connected', 'working', 'waiting']);
    expect(r?.links).toHaveLength(3);
    expect(regionRing('connected', [])).toBeNull();
    expect(spendRing('connected', flow() as never).info.loop).toBe('connected');
    expect(spendRing('connected', flow() as never).meter).toBeCloseTo(0.142, 2);
    const capped = flow({ budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 5, used_turns: 9 } });
    expect(spendRing('connected', capped as never).info.loop).toBe('broken');
    expect(spendRing('broken', flow({ gate: 'budget' }) as never).info.loop).toBe('broken');
    expect(spendRing(null, flow() as never).info.loop).toBe('waiting');
  });

  it('the hero draws learning, regions and spend inside the outreach ring, with the Supervisor at the hub', async () => {
    stubFwd(flow({ state: 'running', gate: null, reason: '1 run(s) in flight.' }));
    const { container } = hero();
    await waitFor(() => expect(container.querySelectorAll('.orbit-learning .orbit-node')).toHaveLength(4));
    await waitFor(() => expect(container.querySelectorAll('.orbit-regions .orbit-node')).toHaveLength(3));
    expect(container.querySelector('.orbit-spend .orbit-meter .loop-line')).not.toBeNull();
    expect(stateOf(container.querySelector('.orbit-hub'))).toBe('working');
    expect(container.querySelectorAll('.flow-hero .loop-node')).toHaveLength(5);
  });

  it('the legend names every ring, outer first, with its state in words', async () => {
    stubFwd(flow());
    const { container } = hero();
    await waitFor(() => expect(container.querySelectorAll('.orbit-legend li')).toHaveLength(4));
    const names = [...container.querySelectorAll('.orbit-key-name')].map((n) => n.firstChild?.textContent);
    expect(names).toEqual(['Outreach', 'Learning', 'Regions', 'Spend']);
    expect(container.querySelector('.orbit-legend')?.textContent).toMatch(/Connected/);
  });

  it('a review fwd cannot answer leaves learning waiting and Unknown', async () => {
    stubFwd(flow(), false);
    const { container } = hero();
    await waitFor(() => expect(container.querySelectorAll('.orbit-learning .orbit-node')).toHaveLength(4));
    const learning = [...container.querySelectorAll('.orbit-key')].find((k) => /Learning/.test(k.textContent ?? ''));
    expect(stateOf(learning)).toBe('waiting');
    expect(learning?.textContent).toMatch(/Unknown/);
  });

  it('clicking a ring in the legend, an inner node or the hub says what it is', async () => {
    stubFwd(flow());
    const { container } = hero();
    await waitFor(() => expect(container.querySelectorAll('.orbit-learning .orbit-node')).toHaveLength(4));
    fireEvent.click(container.querySelectorAll('.orbit-learning .orbit-node')[1]);
    expect((await screen.findByRole('complementary', { name: 'Weekly score' })).textContent).toMatch(/scores/);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(container.querySelector('.orbit-hub') as Element);
    expect((await screen.findByRole('complementary', { name: 'Supervisor' })).textContent).toMatch(/every ring/);
    const spendKey = [...container.querySelectorAll('.orbit-key')].find((k) => /Spend/.test(k.textContent ?? ''));
    fireEvent.keyDown(spendKey as Element, { key: 'Enter' });
    expect((await screen.findByRole('complementary', { name: 'Spend' })).textContent).toMatch(/cap/);
  });

  it('the accent picker sets the site accent, and teal is the default', async () => {
    render(
      <PrefsProvider>
        <AccentPicker />
      </PrefsProvider>,
    );
    const root = document.documentElement;
    await waitFor(() => expect(root.hasAttribute('data-accent')).toBe(false));
    expect((screen.getByRole('radio', { name: 'Teal' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Indigo' }));
    await waitFor(() => expect(root.getAttribute('data-accent')).toBe('indigo'));
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
    await waitFor(() => expect(root.hasAttribute('data-accent')).toBe(false));
  });
});
