// The component checks for FW-C-063; run by probes/flows/morning-intensity.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { FlowControls } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const NAME = 'Neighborhood activation';
const S = `/v1/supervisor/flows/${KEY}`;

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
  schedule: { time: '07:00', days: 'weekdays', cron: '0 7 * * 1-5', timezone: 'America/Los_Angeles' },
  intensity: {
    per_day: 10,
    auto: true,
    min: 4,
    max: 20,
    today: { per_day: 15, why: '9% responded in the last 14 days, so a half more' },
  },
  ...over,
});
const sup = (f = flow()) => ({
  kill_switch: false,
  paused: false,
  max_concurrent: 4,
  running: 0,
  gates: [],
  flows: [f],
  next: [],
});

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFwd(answers: Record<string, { status?: number; body: unknown }>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers[`${method} ${url}`] ?? { body: {} };
    const status = a.status ?? 200;
    const json = status < 300 ? { data: a.body, as_of: new Date().toISOString(), head_seq: 1 } : a.body;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <LiveProvider>
      <FlowControls />
    </LiveProvider>,
  );
const posted = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);

describe('FlowControls morning schedule and intensity', () => {
  it('saves a morning run time on every day', async () => {
    stubFwd({ 'GET /v1/supervisor': { body: sup() }, [`POST ${S}/schedule`]: { body: { changed: true } } });
    show();
    const time = await screen.findByLabelText(`Morning run time for ${NAME}`);
    expect((time as HTMLInputElement).value).toBe('07:00');
    fireEvent.change(time, { target: { value: '05:30' } });
    fireEvent.change(screen.getByLabelText(`Days for ${NAME}`), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: `Save schedule for ${NAME}` }));
    await waitFor(() => expect(posted(`${S}/schedule`).length).toBe(1));
    expect(posted(`${S}/schedule`)[0].body).toEqual({ time: '05:30', days: 'daily' });
  });

  it('saves leads per day with Adjust from replies', async () => {
    stubFwd({ 'GET /v1/supervisor': { body: sup() }, [`POST ${S}/intensity`]: { body: { changed: true } } });
    show();
    const perDay = await screen.findByLabelText(`Leads per day for ${NAME}`);
    expect((perDay as HTMLInputElement).value).toBe('10');
    fireEvent.change(perDay, { target: { value: '6' } });
    const auto = screen.getByLabelText(`Adjust from replies for ${NAME}`) as HTMLInputElement;
    expect(auto.checked).toBe(true);
    fireEvent.click(auto);
    fireEvent.click(screen.getByRole('button', { name: `Save intensity for ${NAME}` }));
    await waitFor(() => expect(posted(`${S}/intensity`).length).toBe(1));
    expect(posted(`${S}/intensity`)[0].body).toEqual({ per_day: 6, auto: false, min: 4, max: 20 });
  });

  it("shows today's number and why", async () => {
    stubFwd({ 'GET /v1/supervisor': { body: sup() } });
    show();
    expect(await screen.findByText(/15 today/)).toBeTruthy();
    expect(screen.getByText(/9% responded in the last 14 days/)).toBeTruthy();
  });
});
