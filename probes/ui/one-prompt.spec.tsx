// The /start checks for FW-C-124; run by probes/ui/one-prompt.mjs (not on its own). Tier 0.
// fwd and the live site are stood in by a fetch stub answering POST /v1/assistant/start.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { routeOf } from '../../packages/web/src/shell/routes';
import { OnePrompt } from '../../packages/web/src/start/OnePrompt';

const now = new Date().toISOString();
const STEPS = [
  { id: 'find', label: 'Find people', detail: 'Finds local people who fit.', needs: null },
  { id: 'draft', label: 'Draft invites', detail: 'Writes a short invite for each.', needs: null },
  { id: 'check', label: 'You check each one', detail: 'Nothing goes out until you say yes.', needs: { kind: 'approval', label: 'You approve every message' } },
  { id: 'send', label: 'Send', detail: 'Sends what you approved.', needs: { kind: 'sender', label: 'Connect your email to send' } },
  { id: 'replies', label: 'Follow up', detail: 'Drafts answers to replies.', needs: null },
];
const FIT = {
  name: 'Austin yoga hosts',
  goal: 'Get yoga teachers in Austin hosting their first class',
  why: 'Finding local teachers and inviting them is what this flow does.',
  base: 'neighborhood-activation',
  dial: 'draft',
  steps: STEPS,
  copy: { method: 'POST', path: '/supervisor/flows/neighborhood-activation/copy', body: { name: 'Austin yoga hosts', note: 'Get yoga teachers in Austin hosting their first class' } },
  build_request: null,
};
const NONE = {
  name: 'Payroll',
  goal: 'Run payroll every other Friday',
  why: 'No payroll flow exists yet.',
  base: null,
  dial: 'draft',
  steps: [],
  copy: null,
  build_request: { title: 'Payroll flow', what: 'Run payroll every other Friday for two staff.', done_when: 'A payroll flow drafts each run for approval.' },
};
let posts: { url: string; body: unknown }[] = [];
let node: unknown = FIT;
beforeEach(() => {
  posts = [];
  node = FIT;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const env = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data, as_of: now, head_seq: 1 }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if ((init.method ?? 'GET') === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      if (url === '/v1/assistant/start') return env({ node, can_make: true });
      if (url.endsWith('/copy')) return env({ key: 'neighborhood-activation--2', flow: null });
      if (url === '/v1/build-requests') return env({ id: 'br_1', status: 'new' }, 201);
      return env({ changed: true });
    }
    return env({});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <LiveProvider>
      <OnePrompt />
    </LiveProvider>,
  );
const ask = async (text: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'What should your business do?' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Make it' }));
  await waitFor(() => expect(posts.length).toBeGreaterThan(0));
};

describe('One prompt (FW-C-124)', () => {
  it('is the page at /start', () => {
    expect(routeOf('/start')).toBe('start');
  });

  it('starts as one box and one button, nothing else', () => {
    const { container } = show();
    expect(screen.getByRole('textbox', { name: 'What should your business do?' })).toBeTruthy();
    expect(within(container).getAllByRole('button').map((b) => b.textContent)).toEqual(['Make it']);
    expect(within(container).queryAllByRole('textbox').length).toBe(1);
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it('turns the prompt into a node whose steps open to what they need, and grows from a second prompt', async () => {
    show();
    await ask('Find yoga teachers in Austin to host');
    expect(posts[0]).toEqual({ url: '/v1/assistant/start', body: { prompt: 'Find yoga teachers in Austin to host' } });
    const n = await screen.findByRole('region', { name: 'Austin yoga hosts' });
    expect(n.textContent).toMatch('Get yoga teachers in Austin hosting their first class');
    for (const s of STEPS) expect(within(n).getByRole('button', { name: new RegExp(`^${s.label}`) })).toBeTruthy();
    expect(n.textContent).not.toMatch('Connect your email to send');
    fireEvent.click(within(n).getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(n.textContent).toMatch('Connect your email to send'));
    fireEvent.change(within(n).getByRole('textbox', { name: 'Add to it' }), { target: { value: 'Also follow up after five days' } });
    fireEvent.click(within(n).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1].body).toEqual({
      prompt: 'Also follow up after five days',
      previous: { name: FIT.name, goal: FIT.goal, base: FIT.base },
    });
  });

  it('makes a draft flow from the node and links to it', async () => {
    show();
    await ask('Find yoga teachers in Austin to host');
    const n = await screen.findByRole('region', { name: 'Austin yoga hosts' });
    fireEvent.click(within(n).getByRole('button', { name: 'Make it a draft flow' }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]).toEqual({ url: '/v1/supervisor/flows/neighborhood-activation/copy', body: FIT.copy.body });
    const open = await screen.findByRole('link', { name: /Open it/ });
    expect(open.getAttribute('href')).toBe('/flows/neighborhood-activation--2');
    expect(n.textContent).toMatch(/Draft/);
  });

  it('offers a build request when nothing fits yet', async () => {
    node = NONE;
    show();
    await ask('Run payroll for my two staff');
    const n = await screen.findByRole('region', { name: 'Payroll' });
    expect(within(n).queryByRole('button', { name: 'Make it a draft flow' })).toBeNull();
    fireEvent.click(within(n).getByRole('button', { name: 'Ask the CTO to build it' }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]).toEqual({ url: '/v1/build-requests', body: NONE.build_request });
    await waitFor(() => expect(n.textContent).toMatch(/Asked/));
  });
});
