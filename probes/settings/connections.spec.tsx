// The Settings checks for FW-C-094; run by probes/settings/connections.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { ConnectionsSettings } from '../../packages/web/src/settings/ConnectionsSettings';

const now = new Date().toISOString();
const CONNECTIONS = {
  email: {
    ready: false,
    settings: true,
    mailboxes: [{ address: 'owner@example.com', password: false }],
    postal: true,
    claim_url: null,
    claim_secret: false,
    last_pass_at: null,
    running: false,
    fix: ['security add-generic-password -s flowweb-email -a owner@example.com -w', 'node senders/email.mjs --once'],
  },
  frequency: { ready: true, site: 'https://frequencylocal.com', outcomes_secret: true, fix: [] },
  ga4: {
    ready: false,
    property_id: '539919559',
    credential: 'crd_ga4paidads',
    key: false,
    last_pull: null,
    fix: ['install -m 600 ~/Downloads/key.json ~/.flowweb/creds/crd_ga4paidads'],
  },
};

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <LiveProvider>
      <ConnectionsSettings />
    </LiveProvider>,
  );

describe('Connections in Settings (FW-C-094)', () => {
  it('shows each connection as Ready or Needs setup, with each fix command and a Copy button', async () => {
    stub(200, { data: CONNECTIONS, as_of: now, head_seq: 1 });
    show();
    const email = await screen.findByRole('region', { name: 'Email sending' });
    const freq = screen.getByRole('region', { name: 'Frequency link' });
    const ga4 = screen.getByRole('region', { name: 'Google Analytics' });
    expect(within(email).getByText('Needs setup')).toBeTruthy();
    expect(within(freq).getByText('Ready')).toBeTruthy();
    expect(within(ga4).getByText('Needs setup')).toBeTruthy();
    for (const [region, list] of [
      [email, CONNECTIONS.email.fix],
      [ga4, CONNECTIONS.ga4.fix],
    ] as const) {
      for (const cmd of list) {
        expect(within(region).getByText(cmd)).toBeTruthy();
        expect(within(region).getByRole('button', { name: `Copy ${cmd}` })).toBeTruthy();
      }
    }
    expect(within(email).getByText('owner@example.com')).toBeTruthy();
    expect(within(ga4).getByText('539919559')).toBeTruthy();
  });

  it('has no field that takes a secret', async () => {
    stub(200, { data: CONNECTIONS, as_of: now, head_seq: 1 });
    const { container } = show();
    await screen.findByRole('region', { name: 'Email sending' });
    expect(container.querySelectorAll('input, textarea, select').length).toBe(0);
  });

  it('asks to update FlowWeb on the machine when it does not answer this yet', async () => {
    stub(404, { error: { code: 'not_found', message: 'No route GET /v1/connections' } });
    show();
    expect(await screen.findByText(/Update FlowWeb on this machine/)).toBeTruthy();
  });
});
