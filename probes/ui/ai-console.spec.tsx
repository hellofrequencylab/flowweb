// The component checks for FW-C-092; run by probes/ui/ai-console.mjs (not on its own). Tier 0.
// The live site is stood in by a fetch stub: /v1/assistant/console answers the console's AI (an answer, the
// proposals the server kept, and whether this person may change things), and any flow control path answers
// the way local fwd does (200, done at once). The page is /flows/neighborhood-activation.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Console } from '../../packages/web/src/console/Console';
import { RouterProvider } from '../../packages/web/src/shell/router';

const KEY = `sk-ant-api03-${'Q1w2E3r4'.repeat(6)}`;
const FLOW = 'neighborhood-activation';
const now = new Date().toISOString();

type Call = { method: string; url: string; body: string };
let calls: Call[] = [];
let reply: { answer: string; proposals: unknown[]; can_change: boolean } = {
  answer: 'Your best source this week is the park clean-up hunt.',
  proposals: [],
  can_change: true,
};

const PROPOSAL = {
  id: 'p1',
  summary: 'Raise leads a day for Neighborhood activation from 5 to 8',
  method: 'POST',
  path: `/supervisor/flows/${FLOW}/intensity`,
  body: { per_day: 8, auto: false, min: 1, max: 25 },
  kind: 'flow.intensity',
  flow: FLOW,
};

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, as_of: now, head_seq: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
  reply = { answer: 'Your best source this week is the park clean-up hunt.', proposals: [], can_change: true };
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), body: init.body ? String(init.body) : '' });
    if (String(url).endsWith('/v1/assistant/console')) return envelope(reply);
    if (String(url).includes('/v1/supervisor/flows/')) return envelope({ ok: true });
    return envelope({});
  });
  history.replaceState(null, '', `/flows/${FLOW}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <RouterProvider>
      <main>
        <h1>Neighborhood activation</h1>
        <p>Leads a day: 5</p>
      </main>
      <Console />
    </RouterProvider>,
  );
const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Open AI console' }));
  return screen.getByRole('dialog', { name: 'AI console' });
};
const ask = (text: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask the AI console' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
};
const consoleCalls = () => calls.filter((c) => c.url.endsWith('/v1/assistant/console'));
const writes = () => calls.filter((c) => c.url.includes('/v1/supervisor/flows/'));

describe('AI console (FW-C-092)', () => {
  it('opens from the bottom right button and names the page and flow it is looking at', () => {
    show();
    const panel = open();
    expect(panel.textContent).toContain(FLOW);
    expect(panel.textContent).toMatch(/Looking at/);
  });

  it('sends the question with the page and the flow, and shows the answer in the conversation', async () => {
    show();
    open();
    ask('What is working best?');
    const log = await screen.findByRole('log', { name: 'Console conversation' });
    await waitFor(() => expect(log.textContent).toContain('park clean-up hunt'));
    expect(log.textContent).toContain('What is working best?');
    expect(consoleCalls()).toHaveLength(1);
    const sent = JSON.parse(consoleCalls()[0].body);
    expect(sent.question).toBe('What is working best?');
    expect(sent.flow).toBe(FLOW);
    expect(sent.page.path).toBe(`/flows/${FLOW}`);
    expect(sent.page.heading).toBe('Neighborhood activation');
    expect(String(sent.page.text)).toContain('Leads a day: 5');
  });

  it('shows a proposed change with Make this change and Not now, and writes nothing yet', async () => {
    reply = { answer: 'Replies are up, so I would raise it.', proposals: [PROPOSAL], can_change: true };
    show();
    open();
    ask('Send more a day');
    const card = await screen.findByRole('group', { name: PROPOSAL.summary });
    expect(within(card).getByRole('button', { name: 'Make this change' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('Make this change sends the same request as the page control and says it is done', async () => {
    reply = { answer: 'Raising it.', proposals: [PROPOSAL], can_change: true };
    show();
    open();
    ask('Send more a day');
    const card = await screen.findByRole('group', { name: PROPOSAL.summary });
    fireEvent.click(within(card).getByRole('button', { name: 'Make this change' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.method).toBe('POST');
    expect(w.url).toMatch(new RegExp(`/v1/supervisor/flows/${FLOW}/intensity$`));
    expect(JSON.parse(w.body)).toEqual(PROPOSAL.body);
    await waitFor(() => expect(card.textContent).toMatch(/Done/));
  });

  it('Not now writes nothing and says it was left alone', async () => {
    reply = { answer: 'Raising it.', proposals: [PROPOSAL], can_change: true };
    show();
    open();
    ask('Send more a day');
    const card = await screen.findByRole('group', { name: PROPOSAL.summary });
    fireEvent.click(within(card).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(card.textContent).toMatch(/Left as it is/));
    expect(within(card).queryByRole('button', { name: 'Make this change' })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('for a role that cannot change things, offers no change buttons and says why', async () => {
    reply = { answer: 'It runs at 06:00.', proposals: [PROPOSAL], can_change: false };
    show();
    open();
    ask('When does it run?');
    const log = await screen.findByRole('log', { name: 'Console conversation' });
    await waitFor(() => expect(log.textContent).toContain('06:00'));
    expect(screen.queryByRole('button', { name: 'Make this change' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'AI console' }).textContent).toMatch(/can ask questions/i);
  });

  it('refuses a pasted key: not shown, not stored, not sent', async () => {
    show();
    open();
    ask(`use this ${KEY}`);
    expect(screen.getByRole('alert').textContent).toMatch(/looks like a key/);
    expect(document.body.textContent).not.toContain(KEY);
    let stored = '';
    try {
      stored = JSON.stringify({ ...sessionStorage });
    } catch {
      /* no storage */
    }
    expect(stored).not.toContain('sk-ant-');
    expect(consoleCalls()).toHaveLength(0);
  });

  it('Escape closes the panel and focus returns to the button', () => {
    show();
    const panel = open();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'AI console' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open AI console' }));
  });
});
