// The component checks for FW-C-105; run by probes/flows/today.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
//
// The surface these checks expect: packages/web/src/flows exports Today({ flow }). Inside a LiveProvider it
// reads GET /v1/flows/{flow}/today and shows a listbox named "Today's actions" with one option per action in
// the order fwd ranked them, each holding the lead's name, niche, town, route and word count; the first is
// selected. The selected action shows its draft text, a source link, and the buttons Copy and open, Mark sent,
// Edit and Skip. Keys on the listbox: J and K move, C copies and opens, S marks sent, E edits, X skips.
// Skip offers Wrong niche, Not local, Not a fit and Already on Frequency, each one tap.
// The button Approve email batch posts the email-route draft ids only.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { Today } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const T = `/v1/flows/${KEY}/today`;
const SUP = `/v1/supervisor/flows/${KEY}/drafts`;
const BATCH = `/v1/flows/${KEY}/batch/approve`;

const action = (id: string, over: Record<string, unknown>) => ({
  id: `draft:${id}`,
  kind: 'cold',
  draft_id: id,
  lead_id: `lead:${id}`,
  name: `Host ${id}`,
  niche: 'sound bath',
  town: 'Encinitas',
  source_url: `https://example.org/source/${id}`,
  route: 'dm',
  open_url: `https://www.instagram.com/${id}_host`,
  to: null,
  subject: `Hello ${id}`,
  body: `Hi ${id}, I'm Daniel, founder of Frequency. Would a free page help your circle?`,
  words: 14,
  score: 0.5,
  created_at: '2026-11-10T10:00:00Z',
  ...over,
});

const ACTIONS = [
  action('d_dm', { name: 'Sunset Sound Bath', niche: 'sound bath', town: 'Leucadia', words: 14 }),
  action('d_mail', {
    kind: 'sequence',
    name: 'Harbor Yoga',
    niche: 'yoga',
    town: 'Carlsbad',
    route: 'email',
    to: 'hello@harbor.example',
    open_url: 'mailto:hello@harbor.example?subject=Hello%20d_mail',
    words: 22,
  }),
  action('d_form', { kind: 'venue', name: 'Studio Nine', niche: 'dance', town: 'Oceanside', route: 'form', open_url: 'https://studio9.example/contact' }),
  action('d_mail2', { name: 'Run Club North', niche: 'running', town: 'Vista', route: 'email', to: 'run@north.example', open_url: 'mailto:run@north.example' }),
];

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFwd({ batch = 200 }: { batch?: number } = {}) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    let data: unknown = {};
    if (method === 'GET' && url === T) data = { flow: KEY, size: 15, ranked_by: 'score', actions: ACTIONS, skips: {} };
    if (method === 'POST' && url === BATCH) {
      if (batch === 404)
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      data = { approved: 2, queued: 2, message: 'Queued 2 emails for the Gmail sender.' };
    }
    return new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

let copied: string[] = [];
let opened: unknown[][] = [];
function stubBrowser() {
  copied = [];
  opened = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => void copied.push(t) },
  });
  vi.spyOn(window, 'open').mockImplementation((...args: unknown[]) => {
    opened.push(args);
    return null;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = () =>
  render(
    <LiveProvider>
      <Today flow={KEY} />
    </LiveProvider>,
  );
const list = () => screen.findByRole('listbox', { name: "Today's actions" });
const selected = () => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');

describe('Today', () => {
  it('lists the ranked actions with lead, niche, town, route and word count', async () => {
    stubFwd();
    stubBrowser();
    show();
    const box = await list();
    const opts = within(box).getAllByRole('option');
    expect(opts.length).toBe(ACTIONS.length);
    expect(opts.map((o) => (o.textContent ?? '').includes(String(ACTIONS[opts.indexOf(o)].name)))).toEqual([true, true, true, true]);
    const first = opts[0].textContent ?? '';
    expect(first).toMatch(/sound bath/);
    expect(first).toMatch(/Leucadia/);
    expect(first).toMatch(/14 words/);
    expect(opts[1].textContent ?? '').toMatch(/[Ee]mail/);
    expect(opts[0].getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain(String(ACTIONS[0].body));
    const src = screen.getAllByRole('link').find((a) => a.getAttribute('href') === ACTIONS[0].source_url);
    expect(src).toBeTruthy();
    expect((document.body.textContent ?? '').includes('—')).toBe(false);
  });

  it('C copies the draft and opens its route in a new tab, and J moves to the next', async () => {
    stubFwd();
    stubBrowser();
    show();
    const box = await list();
    fireEvent.keyDown(box, { key: 'c' });
    await waitFor(() => expect(copied).toEqual([ACTIONS[0].body]));
    expect(opened[0]?.[0]).toBe(ACTIONS[0].open_url);
    expect(opened[0]?.[1]).toBe('_blank');
    fireEvent.keyDown(box, { key: 'j' });
    await waitFor(() => expect(selected()?.textContent).toContain('Harbor Yoga'));
    fireEvent.click(screen.getByRole('button', { name: /Copy and open/ }));
    await waitFor(() => expect(copied.length).toBe(2));
    expect(copied[1]).toBe(ACTIONS[1].body);
    expect(String(opened[1]?.[0])).toMatch(/^mailto:hello@harbor\.example/);
  });

  it('S marks the selected draft sent', async () => {
    stubFwd();
    stubBrowser();
    show();
    const box = await list();
    fireEvent.keyDown(box, { key: 'j' });
    fireEvent.keyDown(box, { key: 'k' });
    fireEvent.keyDown(box, { key: 'j' });
    await waitFor(() => expect(selected()?.textContent).toContain('Harbor Yoga'));
    fireEvent.keyDown(box, { key: 's' });
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${SUP}/d_mail/mark`)).toBe(true));
    expect(calls.find((c) => c.url === `${SUP}/d_mail/mark`)?.body).toEqual({ outcome: 'sent' });
  });

  it('X records a skip with a one-tap reason', async () => {
    stubFwd();
    stubBrowser();
    show();
    const box = await list();
    fireEvent.keyDown(box, { key: 'x' });
    for (const reason of ['Wrong niche', 'Not local', 'Not a fit', 'Already on Frequency'])
      expect(await screen.findByRole('button', { name: reason })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not local' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${SUP}/d_dm/reject`)).toBe(true));
    expect(calls.find((c) => c.url === `${SUP}/d_dm/reject`)?.body).toEqual({ reason: 'not_local' });
  });

  it('Approve email batch posts the email-route ids only, and says so politely on a 404', async () => {
    stubFwd();
    stubBrowser();
    show();
    await list();
    fireEvent.click(screen.getByRole('button', { name: /Approve email batch/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === BATCH)).toBe(true));
    expect(calls.find((c) => c.url === BATCH)?.body).toEqual({ draft_ids: ['d_mail', 'd_mail2'] });
    expect(await screen.findByText(/Queued 2 emails/)).toBeTruthy();
    cleanup();

    stubFwd({ batch: 404 });
    show();
    await list();
    fireEvent.click(screen.getByRole('button', { name: /Approve email batch/ }));
    expect(await screen.findByText(/not on this FlowWeb yet/)).toBeTruthy();
  });
});
