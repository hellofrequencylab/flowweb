// The component checks for FW-C-097; run by probes/flows/live-runs.mjs (not on its own). Tier 0.
// fwd (or the hosted mirror) is stood in by a fetch stub that answers each route with fwd's envelope.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The hosted mirror (flowweb.app) has no event stream: only a newer push can refresh a screen.
// A getter, because a mocked module is kept across tests: each read sees the test's own setting.
vi.mock('../../packages/web/src/hosted/auth', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return Object.defineProperty({ ...real }, 'HOSTED', {
    enumerable: true,
    get: () => (globalThis as { __fwHosted?: boolean }).__fwHosted === true,
  });
});

const KEY = 'neighborhood-activation';
const NAME = 'Frequency Saturation Engine';

const flow = (state: string) => ({
  key: KEY,
  name: NAME,
  enabled: true,
  dial: 'draft',
  tier: 'L1',
  state,
  gate: state === 'running' ? null : 'not_due',
  reason: state === 'running' ? '1 run(s) in flight.' : 'Nothing is due: no scheduled or manual run is waiting.',
  open_asks: 0,
  budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.71, used_turns: 8 },
  merged_into: null,
});
const sup = (state: string) => ({
  kill_switch: false,
  paused: false,
  max_concurrent: 4,
  running: state === 'running' ? 1 : 0,
  gates: [],
  flows: [flow(state)],
  next: [],
  sender: { installed: false, last_pass_at: null },
});
const status = {
  version: 'probe',
  kill: { engaged: false },
  open_cards: 0,
  running_runs: 0,
  chain: { ok: true, head_seq: 1, verified_at: null, failed_seq: null },
};

let supCalls = 0;
function stubFwd(supState: () => string, asOf: () => string = () => new Date().toISOString()) {
  supCalls = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^.*\/v1/, '/v1');
    let data: unknown = {};
    if (path === '/v1/supervisor') {
      supCalls++;
      data = sup(supState());
    } else if (path === '/v1/status') data = status;
    return new Response(JSON.stringify({ data, as_of: asOf(), head_seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  (globalThis as { __fwHosted?: boolean }).__fwHosted = false;
});

async function load() {
  const { LiveProvider } = await import('../../packages/web/src/api/live');
  const { FlowHero } = await import('../../packages/web/src/flows/FlowHero');
  const { FlowControls } = await import('../../packages/web/src/flows');
  const { RouterProvider } = await import('../../packages/web/src/shell/router');
  return render(
    <RouterProvider>
      <LiveProvider>
        <FlowHero flowKey={KEY} />
        <FlowControls />
      </LiveProvider>
    </RouterProvider>,
  );
}

describe('a running flow moves; an idle one stays still', () => {
  it('a running flow lights its hero and its Controls row', async () => {
    stubFwd(() => 'running');
    const { container } = await load();
    await screen.findByText(/1 running now/);
    await waitFor(() => expect(container.querySelector('.flow-hero.is-live .flow-hero-body.live-edge')).not.toBeNull());
    expect(container.querySelector('fieldset.live-edge')).not.toBeNull();
    expect(container.querySelector('.flow-hero-state .flow-pulse-dot')).not.toBeNull();
  });

  it('an idle flow has no live class anywhere', async () => {
    stubFwd(() => 'held');
    const { container } = await load();
    await screen.findByText(/0 running now/);
    await waitFor(() => expect(container.querySelector('.flow-hero-body')).not.toBeNull());
    expect(container.querySelector('.live-edge, .is-live')).toBeNull();
  });

  it('on the hosted mirror a newer push refreshes the page without a reload', async () => {
    (globalThis as { __fwHosted?: boolean }).__fwHosted = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state = 'held';
    let push = '2026-11-11T00:00:00.000Z';
    stubFwd(
      () => state,
      () => push,
    );
    const { container } = await load();
    await screen.findByText(/0 running now/);
    // The Mac starts a cycle and the relay pushes a new snapshot.
    state = 'running';
    push = '2026-11-11T00:01:00.000Z';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    await screen.findByText(/1 running now/);
    await waitFor(() => expect(container.querySelector('.flow-hero-body.live-edge')).not.toBeNull());
    // The same push read again refreshes nothing more.
    const before = supCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(supCalls).toBe(before);
  });
});
