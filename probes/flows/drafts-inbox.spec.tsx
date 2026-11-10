// The component checks for FW-C-066; run by probes/flows/drafts-inbox.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;

const draft = (id: string, subject: string, body: string, created: string, over: Record<string, unknown> = {}) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'founder_email',
  subject,
  body,
  status: 'waiting_for_owner',
  created_at: created,
  ...over,
});

const DRAFTS = [
  draft('d_old', 'Older ready note', 'Hi Old Town Garden Club, an older note.', '2026-11-08T10:00:00Z'),
  draft('d_new', 'Newest ready note', 'Hi Front Porch Gallery, the newest note.', '2026-11-10T10:00:00Z'),
  draft('d_tpl', 'A note for {{venue_name}}', 'Hi {{venue_name}}, a template.', '2026-11-10T11:00:00Z', {
    lead_id: 'template:host',
  }),
  draft('d_sent', 'Sent note', 'Hi Carlsbad Makers, a sent note.', '2026-11-07T10:00:00Z', {
    sent_at: '2026-11-08T09:00:00Z',
    replied_at: '2026-11-09T09:00:00Z',
  }),
  draft('d_rej', 'Rejected note', 'Hi Nobody, a rejected note.', '2026-11-06T10:00:00Z', {
    status: 'rejected',
    rejected_at: '2026-11-06T12:00:00Z',
  }),
];

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFwd() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    let data: unknown = {};
    if (method === 'GET' && url === D) data = DRAFTS;
    else if (method === 'POST' && url.endsWith('/rewrite')) data = { subject: 'Rewritten', body: 'A rewritten note.' };
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

const show = () =>
  render(
    <LiveProvider>
      <DraftsInbox flow={KEY} />
    </LiveProvider>,
  );
const viewer = () => screen.getByRole('region', { name: 'Draft viewer' });

describe('DraftsInbox', () => {
  it('lists every draft with its state word', async () => {
    stubFwd();
    show();
    const list = await screen.findByRole('listbox', { name: 'All drafts' });
    const opts = within(list).getAllByRole('option');
    expect(opts.length).toBe(DRAFTS.length);
    const name = (subject: string) => opts.find((o) => (o.textContent ?? '').includes(subject))?.textContent ?? '';
    expect(name('Newest ready note')).toMatch(/Ready/);
    expect(name('Older ready note')).toMatch(/Ready/);
    expect(name('{{venue_name}}')).toMatch(/Has blanks/);
    expect(name('Sent note')).toMatch(/Replied/);
    expect(name('Rejected note')).toMatch(/Rejected/);
  });

  it('opens the newest ready draft first', async () => {
    stubFwd();
    show();
    await screen.findByRole('listbox', { name: 'All drafts' });
    await waitFor(() => expect(viewer().textContent).toContain('Hi Front Porch Gallery, the newest note.'));
    const selected = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain('Newest ready note');
  });

  it('shows the draft you click', async () => {
    stubFwd();
    show();
    const list = await screen.findByRole('listbox', { name: 'All drafts' });
    const sent = within(list)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').includes('Sent note'));
    if (!sent) throw new Error('no option for the sent draft');
    fireEvent.click(sent);
    await waitFor(() => expect(sent.getAttribute('aria-selected')).toBe('true'));
    expect(viewer().textContent).toContain('Hi Carlsbad Makers, a sent note.');
    expect(viewer().textContent).not.toContain('the newest note');
  });

  it('moves down the list with the arrow key', async () => {
    stubFwd();
    show();
    const list = await screen.findByRole('listbox', { name: 'All drafts' });
    await waitFor(() => expect(viewer().textContent).toContain('the newest note'));
    const opts = within(list).getAllByRole('option');
    const at = opts.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(opts[at + 1].getAttribute('aria-selected')).toBe('true'));
    expect(opts[at].getAttribute('aria-selected')).not.toBe('true');
    expect(viewer().textContent).not.toContain('the newest note');
  });

  it('rewrites the selected draft with AI', async () => {
    stubFwd();
    show();
    const list = await screen.findByRole('listbox', { name: 'All drafts' });
    const older = within(list)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').includes('Older ready note'));
    if (!older) throw new Error('no option for the older draft');
    fireEvent.click(older);
    await waitFor(() => expect(viewer().textContent).toContain('Old Town Garden Club'));
    const ask = within(viewer()).getByRole('textbox', { name: 'Tell AI how to rewrite this draft' });
    fireEvent.change(ask, { target: { value: 'Mention our Carlsbad Circles' } });
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Rewrite' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${D}/d_old/rewrite`)).toBe(true));
    const post = calls.find((c) => c.url === `${D}/d_old/rewrite`);
    expect((post?.body as { instruction?: string }).instruction).toBe('Mention our Carlsbad Circles');
  });
});
