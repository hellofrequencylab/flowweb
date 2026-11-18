// The component checks for FW-C-170; run by probes/flows/draft-source.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;
const SUPERVISOR = { flows: [], sender: { installed: false, last_pass_at: null } };

const draft = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'founder_email',
  subject: 'Your Saturday market',
  body,
  status: 'waiting_for_owner',
  created_at: '2026-11-18T10:00:00Z',
  to: 'hello@frontporch.example',
  ...over,
});

let calls: { method: string; url: string }[] = [];

function stubFwd(drafts: Record<string, unknown>[]) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    const data: unknown =
      method === 'GET' && url === D ? drafts : method === 'GET' && url === '/v1/supervisor' ? SUPERVISOR : {};
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

async function open(drafts: Record<string, unknown>[], first: string) {
  stubFwd(drafts);
  render(
    <LiveProvider>
      <DraftsInbox flow={KEY} />
    </LiveProvider>,
  );
  await screen.findByRole('listbox', { name: 'All drafts' });
  await waitFor(() => expect(viewer().textContent).toContain(first));
}

describe('Where a draft was found', () => {
  it('the viewer links to the page the contact was found on, in a new tab', async () => {
    await open(
      [draft('d_one', 'Hi Front Porch Gallery, a note.', { source_url: 'https://www.frontporch.example/contact-us' })],
      'a note.',
    );
    const link = within(viewer()).getByRole('link', { name: 'frontporch.example' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.frontporch.example/contact-us');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel') ?? '').toContain('noopener');
    expect(viewer().textContent).toContain('Found on');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a draft with no page, or one that is not a web address, shows no link and says so', async () => {
    await open([draft('d_none', 'Hi River Yoga, a second note.', { source_url: 'javascript:alert(1)' })], 'a second note.');
    expect(viewer().textContent).toContain('No source page on record');
    expect(within(viewer()).queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('javascript')).length).toBe(0);
    expect(within(viewer()).queryByText('Found on', { exact: false })).toBeNull();
  });
});
