// The component checks for FW-C-115; run by probes/ui/flow-cards.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers GET /v1/supervisor with three flows and no sender.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowControls } from '../../packages/web/src/flows';

const budget = { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.43, used_turns: 8 };
const flow = (key: string, name: string, over: Record<string, unknown> = {}) => ({
  key,
  name,
  enabled: true,
  dial: 'draft',
  tier: 'L1',
  state: 'held',
  gate: 'not_due',
  reason: 'Nothing is due',
  open_asks: 0,
  budget,
  ...over,
});
const FLOWS = [
  flow('local-saturation', 'Local saturation', { enabled: false, gate: 'flow_disabled', reason: 'Off' }),
  flow('neighborhood-activation', 'Saturation engine', {
    schedule: { time: '06:00', days: 'weekdays', cron: '0 6 * * 1-5', timezone: 'America/Los_Angeles' },
    intensity: { per_day: 10, auto: false, min: 1, max: 25, today: { per_day: 10, why: 'As you set it.' } },
  }),
  flow('paid-ads', 'Paid ads', { gate: 'no_engine', reason: 'No logic yet', budget: null }),
];

function stubFwd() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    let data: unknown = {};
    if (method === 'GET' && url === '/v1/supervisor')
      data = {
        kill_switch: false,
        paused: false,
        max_concurrent: 4,
        running: 0,
        gates: [],
        flows: FLOWS,
        next: [],
        sender: { installed: false, last_pass_at: null },
      };
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

const cards = async () => {
  stubFwd();
  render(
    <LiveProvider>
      <FlowControls />
    </LiveProvider>,
  );
  return Promise.all(FLOWS.map((f) => screen.findByRole('group', { name: f.name })));
};

describe('flow cards', () => {
  it('builds every flow as the same card', async () => {
    for (const g of await cards()) {
      expect(g.tagName).toBe('FIELDSET');
      expect(g.classList.contains('flow-card')).toBe(true);
    }
  });

  it('gives Turn on/off and Run now one size, and neither is a bare link', async () => {
    for (const [i, g] of (await cards()).entries()) {
      const name = FLOWS[i].name;
      const toggle = within(g).getByRole('button', { name: new RegExp(`^Turn (on|off) ${name}$`) });
      const run = within(g).getByRole('button', { name: `Run ${name} now` });
      for (const b of [toggle, run]) {
        expect(b.classList.contains('btn-small')).toBe(true);
        expect(b.classList.contains('btn-quiet')).toBe(false);
      }
    }
  });

  it('shows the dial as a segmented control with one hint for the chosen stop', async () => {
    for (const [i, g] of (await cards()).entries()) {
      const dial = within(g).getByRole('radiogroup', { name: `Dial for ${FLOWS[i].name}` });
      expect(dial.classList.contains('segmented')).toBe(true);
      const names = within(dial)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent?.trim());
      expect(names).toEqual(['Draft', 'Copilot', 'Autopilot']);
      expect(within(g).getAllByText('Writes drafts. You copy and send each one.').length).toBe(1);
    }
  });

  it('explains how to set up a sender once for the list, not on every card', async () => {
    await cards();
    const steps = screen.getAllByRole('link').filter((a) => /senders\/README/.test(a.getAttribute('href') ?? ''));
    expect(steps.length).toBe(1);
  });
});
