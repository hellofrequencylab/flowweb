// The component checks for FW-C-116; run by probes/flows/flow-manage.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers GET /v1/supervisor and records every POST.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowControls } from '../../packages/web/src/flows';

const budget = { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.43, used_turns: 8 };
const flow = (key: string, name: string, over: Record<string, unknown> = {}) => ({
  key,
  name,
  default_name: name,
  note: null,
  archived: false,
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
  flow('neighborhood-activation', 'Saturation engine', { note: 'North County first.' }),
  flow('paid-ads', 'Paid ads'),
  flow('host-moments', 'Host moments', { archived: true, enabled: false, gate: 'flow_disabled' }),
];

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFwd() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    let data: unknown = { changed: true };
    if (method === 'GET' && url === '/v1/supervisor')
      data = {
        kill_switch: false,
        paused: false,
        max_concurrent: 4,
        running: 0,
        gates: [],
        flows: FLOWS,
        next: [],
        sender: { installed: true, last_pass_at: '2026-11-11T10:00:00Z' },
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

const show = async () => {
  stubFwd();
  render(
    <LiveProvider>
      <FlowControls />
    </LiveProvider>,
  );
  return screen.findByRole('group', { name: 'Paid ads' });
};
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === `/v1/supervisor/flows/${path}`);

describe('flow admin', () => {
  it('renames and notes a flow from its card', async () => {
    const card = within(await show());
    fireEvent.click(card.getByRole('button', { name: 'Edit Paid ads' }));
    fireEvent.change(card.getByLabelText('Name for Paid ads'), { target: { value: 'Local ads' } });
    fireEvent.change(card.getByLabelText('Note for Paid ads'), { target: { value: 'Coast first.' } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('paid-ads/edit').length).toBe(1));
    expect(posted('paid-ads/edit')[0].body).toEqual({ name: 'Local ads', note: 'Coast first.' });
  });

  it('asks before it archives, then archives', async () => {
    const card = within(await show());
    fireEvent.click(card.getByRole('button', { name: 'Edit Paid ads' }));
    fireEvent.click(card.getByRole('button', { name: 'Archive Paid ads' }));
    expect(posted('paid-ads/archive').length).toBe(0);
    fireEvent.click(card.getByRole('button', { name: 'Yes, archive' }));
    await waitFor(() => expect(posted('paid-ads/archive').length).toBe(1));
  });

  it('lists an archived flow with Restore instead of a card', async () => {
    await show();
    expect(screen.queryByRole('group', { name: 'Host moments' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Host moments' }));
    await waitFor(() => expect(posted('host-moments/restore').length).toBe(1));
  });

  it("shows a flow's note on its card", async () => {
    await show();
    const card = within(screen.getByRole('group', { name: 'Saturation engine' }));
    expect(card.getByText('North County first.')).toBeTruthy();
  });
});
