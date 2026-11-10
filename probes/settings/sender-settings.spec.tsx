// The Settings checks for FW-C-095; run by probes/settings/sender-settings.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { ConnectionsSettings } from '../../packages/web/src/settings/ConnectionsSettings';

const now = new Date().toISOString();
const VALUES = {
  mailboxes: [{ key: 'personal', address: 'owner@example.com', name: 'Owner Name' }],
  postal: '1 Main St, Town, ST 00000',
  daily_cap: 10,
  per_pass: 1,
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
};
const CONNECTIONS = {
  email: {
    ready: false,
    settings: true,
    values: VALUES,
    mailboxes: [{ address: 'owner@example.com', password: false }],
    postal: true,
    claim_url: null,
    claim_secret: false,
    last_pass_at: null,
    running: false,
    fix: ['node senders/email.mjs --once'],
  },
  frequency: { ready: true, site: null, outcomes_secret: true, fix: [] },
  ga4: { ready: true, property_id: '1', credential: 'crd_ga4paidads', key: true, last_pull: null, fix: [] },
};
let posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const env = (data: unknown) =>
      new Response(JSON.stringify({ data, as_of: now, head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if ((init.method ?? 'GET') === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return env({});
    }
    return env(CONNECTIONS);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (canChange = true) =>
  render(
    <LiveProvider>
      <ConnectionsSettings canChange={canChange} />
    </LiveProvider>,
  );

describe("The email sender's settings in Settings (FW-C-095)", () => {
  it('edits the postal address and daily cap and saves every field', async () => {
    show();
    const email = await screen.findByRole('region', { name: 'Email sending' });
    fireEvent.click(within(email).getByRole('button', { name: 'Edit' }));
    const form = within(email).getByRole('form', { name: 'Email sender settings' });
    expect((within(form).getByLabelText('Address') as HTMLInputElement).value).toBe('owner@example.com');
    fireEvent.change(within(form).getByLabelText('Postal address'), { target: { value: '2 Oak Ave, Town, ST 00000' } });
    fireEvent.change(within(form).getByLabelText('Daily cap'), { target: { value: '12' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toMatch(/\/v1\/connections\/email$/);
    expect(posts[0].body).toEqual({ ...VALUES, postal: '2 Oak Ave, Town, ST 00000', daily_cap: 12 });
  });

  it('has no password field', async () => {
    show();
    const email = await screen.findByRole('region', { name: 'Email sending' });
    fireEvent.click(within(email).getByRole('button', { name: 'Edit' }));
    expect(email.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(within(email).queryByLabelText(/password/i)).toBeNull();
  });

  it('is read only for people who may not change it', async () => {
    show(false);
    const email = await screen.findByRole('region', { name: 'Email sending' });
    expect(within(email).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(email).getByText('1 Main St, Town, ST 00000')).toBeTruthy();
  });
});
