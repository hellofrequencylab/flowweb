// The component checks for FW-C-049; run by probes/ui/hunts.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope or error.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadHunts } from '../../packages/web/src/flows';

const BASE = '/v1/flows/neighborhood-activation';
const L1 = 'https://example.com/events/encinitas';
const L2 = 'https://example.org/calendar';
const REGIONS = [
  { id: 'north-county-sd', name: 'North County San Diego' },
  { id: 'orange-county', name: 'Orange County' },
];
const HUNT = {
  id: 'hnt_1',
  name: 'Sound baths',
  looking_for: 'sound baths',
  region: 'north-county-sd',
  areas: [],
  links: [L1],
  every_days: 1,
  max_sends: 10,
  build: false,
  enabled: true,
  created_at: '2026-11-10T00:00:00Z',
  last_run_at: null,
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFwd(answers: Record<string, { status?: number; body: unknown }>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers[`${method} ${url}`] ?? { body: {} };
    const status = a.status ?? 200;
    const json = status < 300 ? { data: a.body, as_of: '2026-11-10T12:00:00Z', head_seq: 1 } : a.body;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('LeadHunts', () => {
  it('lists the saved hunts with a run and a delete button each', async () => {
    stubFwd({ [`GET ${BASE}/hunts`]: { body: [HUNT] } });
    render(<LeadHunts regions={REGIONS} />);
    expect(screen.getByRole('heading', { name: 'Lead hunts' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Run Sound baths now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Sound baths' })).toBeTruthy();
  });

  it('saves a hunt with its pages, how often and the cap, then lists it again', async () => {
    stubFwd({ [`GET ${BASE}/hunts`]: { body: [] }, [`POST ${BASE}/hunts`]: { status: 201, body: HUNT } });
    render(<LeadHunts regions={REGIONS} />);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    field('Name', 'Sound baths');
    field('Looking for', 'sound baths and breathwork');
    field('Region', 'north-county-sd');
    field('Pages to search first', `${L1}\n\n${L2}\n`);
    field('Every how many days', '3');
    field('Most messages per run', '5');
    fireEvent.click(screen.getByLabelText('Build a page they can claim'));
    fireEvent.click(screen.getByRole('button', { name: 'Save hunt' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: `${BASE}/hunts`,
      body: {
        name: 'Sound baths',
        looking_for: 'sound baths and breathwork',
        region: 'north-county-sd',
        links: [L1, L2],
        every_days: 3,
        max_sends: 5,
        build: true,
      },
    });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1));
  });

  it("shows fwd's refusal and keeps what was typed", async () => {
    stubFwd({
      [`GET ${BASE}/hunts`]: { body: [] },
      [`POST ${BASE}/hunts`]: {
        status: 400,
        body: { error: { code: 'validation_failed', message: 'links must be at most 20 http or https addresses' } },
      },
    });
    render(<LeadHunts regions={REGIONS} />);
    field('Name', 'Bad');
    field('Looking for', 'x');
    field('Region', 'north-county-sd');
    field('Pages to search first', 'javascript:alert(1)');
    fireEvent.click(screen.getByRole('button', { name: 'Save hunt' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/links must be/);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Bad');
  });

  it('adds an address to do-not-contact with a reason', async () => {
    stubFwd({
      [`GET ${BASE}/hunts`]: { body: [] },
      [`POST ${BASE}/do-not-contact`]: { body: { blocked: 'organizer@example.com', already: false } },
    });
    render(<LeadHunts regions={REGIONS} />);
    field('Address or @domain', 'organizer@example.com');
    field('Reason', 'replied no');
    fireEvent.click(screen.getByRole('button', { name: 'Add to do-not-contact' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/do-not-contact'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/do-not-contact'))?.body).toEqual({
      email: 'organizer@example.com',
      reason: 'replied no',
    });
    expect(await screen.findByText(/organizer@example\.com/)).toBeTruthy();
  });

  it('runs a hunt and says what the Supervisor did, and deletes one after a confirm', async () => {
    stubFwd({
      [`GET ${BASE}/hunts`]: { body: [HUNT] },
      [`POST ${BASE}/hunts/hnt_1/run`]: { body: { hunt_id: 'hnt_1', fire_id: 'f1', outcome: 'fired' } },
      [`DELETE ${BASE}/hunts/hnt_1`]: { body: { deleted: 'hnt_1' } },
    });
    vi.stubGlobal('confirm', () => true);
    render(<LeadHunts regions={REGIONS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Sound baths now' }));
    expect(await screen.findByText(/fired/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sound baths' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `${BASE}/hunts/hnt_1`)).toBe(true));
  });
});
