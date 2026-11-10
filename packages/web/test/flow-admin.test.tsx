import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowAdminView } from '../src/api/client';
import { FlowAdmin } from '../src/flows';

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

/** fwd stand-in: answers each route with an envelope, or with the error a test sets. */
function stubFwd(answers: Record<string, { status?: number; body: unknown }>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
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

const BASE = '/v1/flows/neighborhood-activation';
const [NC, LOGGED] = ['north-county-sd', 'Uploaded leads: 2 added, 0 updated, 0 skipped.'];
const view = (over: Partial<FlowAdminView> = {}): FlowAdminView => ({
  thresholds: { hosts_floor: 100, hosts_per_10k: 0.75, hold_weeks: 4 },
  territories: [
    { id: 'north-county-sd', name: 'North County San Diego', status: 'active' },
    { id: 'orange-county', name: 'Orange County', status: 'waiting' },
  ],
  decision: { kind: 'keep_working', territory_id: 'north-county-sd', summary: 'Working North County.' },
  leads: [
    { id: 'ld_1', name: 'Ana', kind: 'host', territory_id: NC, stage: 'invite', send_via: 'founder_email' },
    { id: 'ld_2', name: 'Cafe', kind: 'venue', territory_id: NC, stage: 'blocked', send_via: null },
  ],
  admin_log: [{ at: '2026-11-10T11:00:00Z', action: 'leads', summary: LOGGED }],
  ...over,
});

describe('FlowAdmin', () => {
  it('uploads pasted leads and lists the skipped rows with their reasons', async () => {
    stubFwd({
      [`POST ${BASE}/leads`]: {
        body: { added: 2, updated: 0, skipped: [{ row: 3, reason: 'kind "wizard" is not known' }] },
      },
    });
    const refresh = vi.fn();
    render(<FlowAdmin flow={view()} refresh={refresh} />);
    const [leadsBox] = screen.getAllByLabelText('Or paste the CSV here');
    fireEvent.change(leadsBox!, { target: { value: 'name,kind\nAna,host' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Upload' })[0]!);
    expect(await screen.findByText('2 added, 0 updated, 1 skipped.')).toBeTruthy();
    expect(screen.getByText('Row 3: kind "wizard" is not known')).toBeTruthy();
    expect(calls[0]).toMatchObject({ method: 'POST', body: { format: 'csv', data: 'name,kind\nAna,host' } });
    expect(refresh).toHaveBeenCalled();
  });

  it('opens the proposed region only after a confirm step', async () => {
    stubFwd({});
    const decision = {
      kind: 'propose_expansion',
      territory_id: 'orange-county',
      summary: 'Open Orange County next?',
    };
    render(<FlowAdmin flow={view({ decision })} refresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Orange County' }));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, open Orange County' }));
    await waitFor(() =>
      expect(calls[0]).toMatchObject({ url: `${BASE}/open`, body: { territory_id: 'orange-county' } }),
    );
  });

  it('hides the open button when nothing is proposed', () => {
    stubFwd({});
    render(<FlowAdmin flow={view()} refresh={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
  });

  it('marks a send with the chosen route, and offers no send on a blocked lead', async () => {
    stubFwd({});
    render(<FlowAdmin flow={view()} refresh={() => {}} />);
    fireEvent.change(screen.getByLabelText('Route for Ana'), { target: { value: 'frequency' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }));
    expect(await screen.findByText('Marked sent: Frequency message.')).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: `${BASE}/leads/ld_1/touches`, body: { via: 'frequency' } });
    expect(screen.getAllByRole('button', { name: 'Mark sent' })).toHaveLength(1);
    expect(screen.getByText(/On the do-not-contact list/)).toBeTruthy();
  });

  it('adds a lead to the do-not-contact list with a reason', async () => {
    stubFwd({});
    render(<FlowAdmin flow={view()} refresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Do not contact' }));
    fireEvent.change(screen.getByLabelText('Why should Ana not be contacted?'), {
      target: { value: 'asked' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to the do-not-contact list' }));
    await waitFor(() => expect(calls[0]).toMatchObject({ body: { lead_id: 'ld_1', reason: 'asked' } }));
  });

  it('saves targets into the full config and shows the reasons fwd refuses one', async () => {
    const cfg = { version: 1, territories: [{ id: 'x' }], activation: { hosts_floor: 100, hold_weeks: 4 } };
    const errors = ['region x needs at least 2 sub-areas'];
    stubFwd({
      [`GET ${BASE}/config`]: { body: cfg },
      [`PUT ${BASE}/config`]: {
        status: 400,
        body: {
          error: { code: 'validation_failed', message: 'the config is not valid', details: { errors } },
        },
      },
    });
    render(<FlowAdmin flow={view()} refresh={() => {}} />);
    fireEvent.change(screen.getByLabelText('Fewest active hosts any region needs'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save targets' }));
    expect(await screen.findByText(errors[0]!)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({
      version: 1,
      territories: [{ id: 'x' }],
      activation: { hosts_floor: 120, hold_weeks: 4 },
    });
  });

  it('refuses raw config that is not JSON before calling fwd', async () => {
    stubFwd({ [`GET ${BASE}/config`]: { body: { activation: {} } } });
    render(<FlowAdmin flow={view()} refresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load the current config' }));
    fireEvent.change(await screen.findByLabelText('Config (JSON)'), { target: { value: '{ nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    expect(await screen.findByText(/not valid JSON/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('links the CSV export and shows the admin log', () => {
    stubFwd({});
    render(<FlowAdmin flow={view()} refresh={() => {}} />);
    expect(screen.getByRole('link', { name: 'Export leads (CSV)' }).getAttribute('href')).toBe(
      `${BASE}/leads.csv`,
    );
    expect(screen.getByText(LOGGED)).toBeTruthy();
  });
});
