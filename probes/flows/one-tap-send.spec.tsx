// The component checks for FW-C-163; run by probes/flows/one-tap-send.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope and remembers a draft
// marked sent, as fwd does.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;
// No sender reads the outbox (FW-C-071), so a ready draft offers Copy and send.
const SUPERVISOR = { flows: [], sender: { installed: false, last_pass_at: null } };

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

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let opened: string[] = [];
let copied = 0;

function stubFwd(drafts: Record<string, unknown>[]) {
  calls = [];
  opened = [];
  copied = 0;
  const sent = new Set<string>();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async () => {
        copied += 1;
      },
    },
  });
  vi.stubGlobal('open', (url: string) => {
    opened.push(String(url));
    return null;
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    const mark = /\/drafts\/([^/]+)\/mark$/.exec(url);
    if (method === 'POST' && mark && body?.outcome === 'sent') sent.add(mark[1]);
    const data: unknown =
      method === 'GET' && url === D
        ? drafts.map((d) => (sent.has(String(d.id)) ? { ...d, sent_at: '2026-11-18T18:00:00Z' } : d))
        : method === 'GET' && url === '/v1/supervisor'
          ? SUPERVISOR
          : {};
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
const posts = () => calls.filter((c) => c.method !== 'GET');

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

const TWO = [
  draft('d_first', 'Your Saturday market', 'Hi Front Porch Gallery, a note about your market & more.', '2026-11-18T10:00:00Z', {
    to: 'hello@frontporch.example',
  }),
  draft('d_second', 'Your garden club', 'Hi Old Town Garden Club, a second note.', '2026-11-17T10:00:00Z', {
    to: 'club@oldtown.example',
  }),
];

describe('Sending a draft in one tap', () => {
  it('Copy and send starts a filled-in message to the address in your own mail and changes nothing', async () => {
    await open(TWO, 'a note about your market');
    expect(within(viewer()).queryByRole('button', { name: 'Yes, I sent it' })).toBeNull();
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy and send' }));
    await waitFor(() => expect(opened.length).toBe(1));
    const url = decodeURIComponent(opened[0]);
    expect(url).toContain('hello@frontporch.example');
    expect(url).toContain('Your Saturday market');
    expect(url).toContain('a note about your market & more.');
    // The body's "&" must travel encoded, or the mail app cuts the note there.
    expect(opened[0]).not.toContain('market & more');
    expect(copied).toBe(1);
    expect(posts()).toEqual([]);
  });

  it('then asks whether it went: Yes marks it sent and opens the next ready draft', async () => {
    await open(TWO, 'a note about your market');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy and send' }));
    fireEvent.click(await within(viewer()).findByRole('button', { name: 'Yes, I sent it' }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0].url).toBe(`${D}/d_first/mark`);
    expect(posts()[0].body).toEqual({ outcome: 'sent' });
    await waitFor(() => expect(viewer().textContent).toContain('a second note'));
    expect(within(viewer()).getByRole('button', { name: 'Copy and send' })).toBeTruthy();
  });

  it('Not yet marks nothing, and a draft with no email address opens no message', async () => {
    const dm = [draft('d_dm', 'A note by DM', 'Hi River Yoga, a note for a DM.', '2026-11-18T10:00:00Z', { to: 'https://example.org/contact' })];
    await open(dm, 'a note for a DM');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy and send' }));
    fireEvent.click(await within(viewer()).findByRole('button', { name: 'Not yet' }));
    await waitFor(() => expect(within(viewer()).queryByRole('button', { name: 'Yes, I sent it' })).toBeNull());
    expect(copied).toBe(1);
    expect(opened).toEqual([]);
    expect(posts()).toEqual([]);
  });
});
