// The component checks for FW-C-171; run by probes/flows/draft-contact-page.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;
// No sender reads the outbox (FW-C-071), so a ready draft offers Copy and send.
const SUPERVISOR = { flows: [], sender: { installed: false, last_pass_at: null } };

const draft = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'frequency',
  subject: 'Your Sunday class',
  body,
  status: 'waiting_for_owner',
  created_at: '2026-11-18T10:00:00Z',
  ...over,
});

let calls: { method: string; url: string }[] = [];
let opened: string[] = [];
let copied = 0;
let texts: string[] = [];

function stubFwd(drafts: Record<string, unknown>[]) {
  calls = [];
  opened = [];
  copied = 0;
  texts = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        texts.push(t);
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

describe('A draft with no email address', () => {
  it('says so before the press, and Copy and send opens the contact page it goes through', async () => {
    await open(
      [draft('d_form', 'Hi River Yoga, a note for your form.', { contact_url: 'https://www.riveryoga.example/contact' })],
      'a note for your form.',
    );
    expect(viewer().textContent).toContain('No email address');
    expect(viewer().textContent).toContain('riveryoga.example');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy and send' }));
    await waitFor(() => expect(copied).toBe(1));
    expect(opened).toEqual(['https://www.riveryoga.example/contact']);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('with no contact page either, says the button only copies the note, and opens nothing', async () => {
    await open([draft('d_bare', 'Hi Old Town Club, a bare note.')], 'a bare note.');
    expect(viewer().textContent).toContain('only copies the note');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy and send' }));
    await waitFor(() => expect(copied).toBe(1));
    expect(opened).toEqual([]);
  });

  it('an email draft shows the address it goes to, with one-press copies of the address, subject and message', async () => {
    await open(
      [draft('d_mail', 'Hi Sol Studio, a note for your inbox.', { to: 'hello@solstudio.example' })],
      'a note for your inbox.',
    );
    expect(viewer().textContent).toContain('To hello@solstudio.example');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy address' }));
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy subject' }));
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(texts.length).toBe(3));
    expect(texts).toEqual(['hello@solstudio.example', 'Your Sunday class', 'Hi Sol Studio, a note for your inbox.']);
    expect(opened).toEqual([]);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});
