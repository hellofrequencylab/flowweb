// The component checks for FW-C-068; run by probes/ui/inbox.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { TopNav } from '../../packages/web/src/shell/Nav';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { RouterProvider } from '../../packages/web/src/shell/router';
import { TablePage } from '../../packages/web/src/table/TablePage';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;

const draft = (id: string, subject: string, created: string, over: Record<string, unknown> = {}) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'founder_email',
  subject,
  body: `Hi there, ${subject}.`,
  status: 'waiting_for_owner',
  created_at: created,
  ...over,
});

const READY = [
  draft('d_1', 'First ready note', '2026-11-10T10:00:00Z'),
  draft('d_2', 'Second ready note', '2026-11-10T09:00:00Z'),
];
const OTHER = [
  draft('d_tpl', 'A note for {{venue_name}}', '2026-11-10T11:00:00Z', { lead_id: 'template:host' }),
  draft('d_sent', 'Sent note', '2026-11-07T10:00:00Z', { sent_at: '2026-11-08T09:00:00Z' }),
];

const CARD = {
  id: 'dc_open_region',
  variant: 'choose',
  project_id: 'prj_frequency1',
  title: 'Open Orange County next?',
  ask: 'North County held its targets for 4 weeks.',
  urgency: 'this_week',
  deadline_at: null,
  default_on_timeout: 'hold',
  approval_id: null,
  evidence_bundle_id: null,
  body: {},
  status: 'open',
  answer: null,
  answered_by: null,
  answered_at: null,
  created_at: '2026-11-10T08:00:00Z',
  project_name: 'Frequency',
};

const status = (open: number) => ({
  version: 'probe',
  kill: { engaged: false },
  open_cards: open,
  running_runs: 0,
  oldest_open_card_at: null,
  chain: { ok: true, head_seq: 1, verified_at: new Date().toISOString() },
});

function stubFwd(cards: unknown[], drafts: unknown[]) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = String(url).split('?')[0];
    let data: unknown = {};
    let code = 200;
    if (method === 'GET' && path === '/v1/status') data = status(cards.length);
    else if (method === 'GET' && path === '/v1/decision-cards') data = cards;
    else if (method === 'GET' && path === D) data = drafts;
    else if (method === 'GET' && path === '/v1/supervisor')
      data = { paused: false, flows: [{ key: KEY, name: 'Neighborhood activation', enabled: true }] };
    else code = 404;
    return new Response(
      JSON.stringify(code === 200 ? { data, as_of: new Date().toISOString(), head_seq: 1 } : { error: 'not found' }),
      { status: code, headers: { 'content-type': 'application/json' } },
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function at(path: string, ui: React.ReactNode) {
  history.replaceState(null, '', path);
  return render(
    <PrefsProvider>
      <RouterProvider>
        <LiveProvider>{ui}</LiveProvider>
      </RouterProvider>
    </PrefsProvider>,
  );
}

describe('one Inbox', () => {
  it('holds the messages to send and the decisions, on one page', async () => {
    stubFwd([CARD], [...READY, ...OTHER]);
    at('/inbox', <TablePage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Inbox');
    const messages = await screen.findByRole('region', { name: /Messages to send/ });
    const list = await within(messages).findByRole('listbox', { name: 'All drafts' });
    expect(within(list).getAllByRole('option').length).toBe(4);
    const decisions = screen.getByRole('region', { name: /Decisions/ });
    await waitFor(() => expect(decisions.textContent).toContain('Open Orange County next?'));
  });

  it('says how many of each are waiting', async () => {
    stubFwd([CARD], [...READY, ...OTHER]);
    at('/inbox', <TablePage />);
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toMatch(/2 messages to send/);
      expect(text).toMatch(/1 decision\b/);
    });
  });

  it('the nav count adds ready messages to open decisions', async () => {
    stubFwd([CARD], [...READY, ...OTHER]);
    const { container } = at('/', <TopNav />);
    const inbox = within(container)
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/inbox');
    expect(inbox).toBeTruthy();
    await waitFor(() => expect(inbox?.textContent ?? '').toMatch(/3/));
  });

  it('with no decisions it says so, and the messages are still there', async () => {
    stubFwd([], [...READY, ...OTHER]);
    at('/inbox', <TablePage />);
    const decisions = await screen.findByRole('region', { name: /Decisions/ });
    await waitFor(() => expect(decisions.textContent).toMatch(/No decisions waiting/));
    const messages = screen.getByRole('region', { name: /Messages to send/ });
    expect(await within(messages).findByRole('listbox', { name: 'All drafts' })).toBeTruthy();
  });
});
