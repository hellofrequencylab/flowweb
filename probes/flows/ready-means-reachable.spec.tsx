// The component checks for FW-C-172; run by probes/flows/ready-means-reachable.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;
const SUPERVISOR = { flows: [], sender: { installed: false, last_pass_at: null } };

const draft = (id: string, subject: string, created: string, over: Record<string, unknown> = {}) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'frequency',
  subject,
  body: `Hi there, a note about ${subject}.`,
  status: 'waiting_for_owner',
  created_at: created,
  ...over,
});

const DRAFTS = [
  // The newest draft has no way to reach the person, so it must not be the one that opens first.
  draft('d_bare', 'Nobody to write to', '2026-11-18T12:00:00Z'),
  draft('d_mail', 'Has an address', '2026-11-18T11:00:00Z', { to: 'hello@solstudio.example' }),
  draft('d_page', 'Has a contact page', '2026-11-18T10:00:00Z', { contact_url: 'https://riveryoga.example/contact' }),
  draft('d_found', 'Has the page it was found on', '2026-11-18T09:00:00Z', { source_url: 'https://poet.example/' }),
  draft('d_unsafe', 'Has only a bad address', '2026-11-18T08:00:00Z', { to: 'not an address', source_url: 'javascript:alert(1)' }),
];

function stubFwd() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const data: unknown =
      method === 'GET' && url === D ? DRAFTS : method === 'GET' && url === '/v1/supervisor' ? SUPERVISOR : {};
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

const viewer = () => screen.getByRole('region', { name: 'Draft viewer' });

async function open() {
  stubFwd();
  render(
    <LiveProvider>
      <DraftsInbox flow={KEY} />
    </LiveProvider>,
  );
  return screen.findByRole('listbox', { name: 'All drafts' });
}

describe('Ready means there is a way to reach the person', () => {
  it('a draft with an address or a page is Ready; one with neither is No address', async () => {
    const list = await open();
    const opts = within(list).getAllByRole('option');
    const name = (subject: string) => opts.find((o) => (o.textContent ?? '').includes(subject))?.textContent ?? '';
    expect(name('Has an address')).toMatch(/Ready/);
    expect(name('Has a contact page')).toMatch(/Ready/);
    expect(name('Has the page it was found on')).toMatch(/Ready/);
    expect(name('Nobody to write to')).toMatch(/No address/);
    expect(name('Nobody to write to')).not.toMatch(/Ready/);
    expect(name('Has only a bad address')).toMatch(/No address/);
  });

  it('counts them apart, and the No address group lists only those', async () => {
    const list = await open();
    expect(screen.getByRole('button', { name: /^Ready\s*3$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^No address\s*2$/ }));
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(2));
    const text = list.textContent ?? '';
    expect(text).toContain('Nobody to write to');
    expect(text).toContain('Has only a bad address');
    expect(text).not.toContain('Has an address');
  });

  it('opens a draft he can send first, not the newest one with nobody to write to', async () => {
    await open();
    await waitFor(() => expect(viewer().textContent).toContain('a note about Has an address.'));
  });
});
