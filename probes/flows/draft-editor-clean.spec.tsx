// The component checks for FW-C-077; run by probes/flows/draft-editor-clean.mjs (not on its own). Tier 0.
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
];

// A sender on the Mac reads the outbox (FW-C-071), so a ready draft offers Approve.
const SUPERVISOR = { flows: [], sender: { installed: true, last_pass_at: new Date().toISOString() } };

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

const AVATAR = '.group-badge, [class*="avatar"]';
const viewer = () => screen.getByRole('region', { name: 'Draft viewer' });
const names = (el: HTMLElement) => within(el).getAllByRole('button').map((b) => (b.textContent ?? '').trim());

async function open() {
  stubFwd();
  render(
    <LiveProvider>
      <DraftsInbox flow={KEY} />
    </LiveProvider>,
  );
  const list = await screen.findByRole('listbox', { name: 'All drafts' });
  await waitFor(() => expect(viewer().textContent).toContain('the newest note'));
  return list;
}

describe('a clean drafts editor', () => {
  it('shows no initials avatar in the list or the editor', async () => {
    const list = await open();
    expect(list.querySelectorAll(AVATAR).length).toBe(0);
    expect(viewer().querySelectorAll(AVATAR).length).toBe(0);
    const first = within(list)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').includes('Newest ready note'));
    expect((first?.textContent ?? '').trim().startsWith('Front Porch Gallery')).toBe(true);
    const initials = [...viewer().querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.textContent ?? '').trim() === 'FP',
    );
    expect(initials.length).toBe(0);
  });

  it('leads the editor with the subject as its heading', async () => {
    await open();
    expect(within(viewer()).getByRole('heading', { name: 'Newest ready note' })).toBeTruthy();
  });

  it('puts Copy, Edit, Approve and Reject in one action bar before the message', async () => {
    await open();
    const bar = within(viewer()).getByRole('toolbar', { name: 'Draft actions' });
    const got = names(bar);
    for (const n of ['Copy', 'Edit', 'Approve', 'Reject']) expect(got).toContain(n);
    const order = ['Copy', 'Edit', 'Approve', 'Reject'].map((n) => got.indexOf(n));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const body = within(viewer()).getByText(/the newest note/);
    expect(bar.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('holds Save and Cancel in the action bar while editing', async () => {
    await open();
    const bar = within(viewer()).getByRole('toolbar', { name: 'Draft actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(names(within(viewer()).getByRole('toolbar', { name: 'Draft actions' }))).toContain('Save'));
    expect(names(within(viewer()).getByRole('toolbar', { name: 'Draft actions' }))).toContain('Cancel');
  });
});
