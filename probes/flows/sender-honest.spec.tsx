// The component checks for FW-C-071; run by probes/flows/sender-honest.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers GET /v1/status and GET /v1/supervisor (both carrying
// sender { installed, last_pass_at }) and the flow's drafts, each with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox, FlowControls } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const NAME = 'Neighborhood activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;
const NO_SENDER = { installed: false, last_pass_at: null };
const SENDER = { installed: true, last_pass_at: '2026-11-10T16:40:00Z' };

const flow = (dial: string) => ({
  key: KEY,
  name: NAME,
  enabled: true,
  dial,
  tier: 'L1',
  state: 'held',
  gate: 'not_due',
  reason: 'Nothing is due',
  open_asks: 0,
  budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.43, used_turns: 8 },
  schedule: { time: '07:00', days: 'weekdays', cron: '0 7 * * 1-5', timezone: 'America/Los_Angeles' },
  intensity: { per_day: 10, auto: false, min: 1, max: 25, today: { per_day: 10, why: 'As you set it' } },
});
const sup = (sender: unknown, dial: string) => ({
  kill_switch: false,
  paused: false,
  max_concurrent: 4,
  running: 0,
  gates: [],
  flows: [flow(dial)],
  next: [],
  sender,
});
const status = (sender: unknown) => ({
  daemon: 'up',
  version: '0.0.0',
  started_at: '2026-11-10T08:00:00Z',
  kill: { engaged: false },
  chain: { ok: true, head_seq: 1, head_hash: 'a'.repeat(64), verified_at: '2026-11-10T08:00:00Z' },
  sandbox_level: null,
  open_cards: 0,
  running_runs: 0,
  sender,
});
const DRAFTS = [
  {
    id: 'd_ready',
    fire_id: 'f_1',
    lead_id: 'lead:d_ready',
    channel: 'founder_email',
    subject: 'Your Saturday market',
    body: 'Hi Front Porch Gallery, a note about your market. Reply no and I will not write again.',
    status: 'waiting_for_owner',
    created_at: '2026-11-10T10:00:00Z',
  },
];

type Call = { method: string; url: string };
let calls: Call[] = [];
let copied: string[] = [];

function stubFwd(sender: unknown, dial: string) {
  calls = [];
  copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        copied.push(t);
      },
    },
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    let data: unknown = {};
    if (method === 'GET' && url === '/v1/status') data = status(sender);
    else if (method === 'GET' && url === '/v1/supervisor') data = sup(sender, dial);
    else if (method === 'GET' && url === D) data = DRAFTS;
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

const stops = async () => {
  const group = await screen.findByRole('radiogroup', { name: `Dial for ${NAME}` });
  const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
  const by = (v: string) => radios.find((r) => r.value === v);
  return { draft: by('draft'), copilot: by('copilot'), autopilot: by('autopilot') };
};
const inbox = () =>
  render(
    <LiveProvider>
      <DraftsInbox flow={KEY} />
    </LiveProvider>,
  );
const controls = () =>
  render(
    <LiveProvider>
      <FlowControls />
    </LiveProvider>,
  );

describe('The dial and drafts without a sender', () => {
  it('disables Copilot and Autopilot and says a sender is needed when there is none', async () => {
    stubFwd(NO_SENDER, 'draft');
    controls();
    const s = await stops();
    expect(s.draft?.disabled).toBe(false);
    await waitFor(() => expect(s.copilot?.disabled).toBe(true));
    expect(s.autopilot?.disabled).toBe(true);
    expect(screen.getAllByText(/Needs a sender on your Mac/).length).toBeGreaterThan(0);
    const steps = screen.getAllByRole('link').filter((a) => /senders\/README/.test(a.getAttribute('href') ?? ''));
    expect(steps.length).toBeGreaterThan(0);
  });

  it('offers Copilot and Autopilot when a sender is installed', async () => {
    stubFwd(SENDER, 'draft');
    controls();
    const s = await stops();
    await waitFor(() => expect(s.copilot?.disabled).toBe(false));
    expect(s.autopilot?.disabled).toBe(false);
    expect(screen.queryByText(/Needs a sender on your Mac/)).toBeNull();
  });

  it('shows Copy and send instead of Approve without a sender, and it approves nothing', async () => {
    stubFwd(NO_SENDER, 'copilot');
    inbox();
    const viewer = await screen.findByRole('region', { name: 'Draft viewer' });
    const btn = await within(viewer).findByRole('button', { name: 'Copy and send' });
    expect(within(viewer).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(copied.length).toBe(1));
    expect(copied[0]).toContain('Your Saturday market');
    expect(copied[0]).toContain('a note about your market');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/approve'))).toBe(false);
  });

  it('shows Approve when a sender is installed', async () => {
    stubFwd(SENDER, 'copilot');
    inbox();
    const viewer = await screen.findByRole('region', { name: 'Draft viewer' });
    await within(viewer).findByRole('button', { name: 'Approve' });
    expect(within(viewer).queryByRole('button', { name: 'Copy and send' })).toBeNull();
  });
});
