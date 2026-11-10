// The component checks for FW-C-062; run by probes/flows/site-controls.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope or error.
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
  dial: 'copilot',
  tier: 'L1',
  state: 'held',
  gate: 'not_due',
  reason: 'Nothing is due',
  open_asks: 0,
  budget: { max_usd: 5, max_turns: 200, period: 'week', spent_usd: 0.43, used_turns: 8 },
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

describe('FlowControls', () => {
  it('turns a flow off', async () => {
    stubFwd({ 'GET /v1/supervisor': { body: sup() }, [`POST ${S}/disable`]: { body: { changed: true } } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: `Turn off ${NAME}` }));
    await waitFor(() => expect(posted(`${S}/disable`).length).toBe(1));
  });

  it('runs a flow now', async () => {
    stubFwd({ 'GET /v1/supervisor': { body: sup() }, [`POST ${S}/run`]: { body: { outcome: 'admitted' } } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: `Run ${NAME} now` }));
    await waitFor(() => expect(posted(`${S}/run`).length).toBe(1));
  });

  it('moves the dial to Draft', async () => {
    stubFwd({ 'GET /v1/supervisor': { body: sup() }, [`POST ${S}/dial`]: { body: { changed: true } } });
    show();
    const group = await screen.findByRole('radiogroup', { name: `Dial for ${NAME}` });
    for (const word of ['Draft', 'Copilot', 'Autopilot'])
      expect(screen.getAllByRole('radio', { name: new RegExp(`^${word}\\b`) }).length).toBe(1);
    expect(group).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Draft\b/ }));
    await waitFor(() => expect(posted(`${S}/dial`).length).toBe(1));
    expect(posted(`${S}/dial`)[0].body).toEqual({ stop: 'draft' });
  });

  it('asks the Owner to confirm Autopilot and then sends the hash', async () => {
    stubFwd({
      'GET /v1/supervisor': { body: sup() },
      [`POST ${S}/dial`]: {
        status: 409,
        body: { error: { code: 'conflict', message: 'confirm', details: { confirm_hash: 'abc123' } } },
      },
    });
    show();
    await screen.findByRole('radiogroup', { name: `Dial for ${NAME}` });
    fireEvent.click(screen.getByRole('radio', { name: /^Autopilot\b/ }));
    const yes = await screen.findByRole('button', { name: 'Yes, Autopilot' });
    expect(posted(`${S}/dial`)[0].body).toEqual({ stop: 'autopilot' });
    fireEvent.click(yes);
    await waitFor(() => expect(posted(`${S}/dial`).length).toBe(2));
    expect(posted(`${S}/dial`)[1].body).toEqual({ stop: 'autopilot', confirm: 'abc123' });
  });
});
