import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ hosted: false }));
vi.mock('../src/hosted/auth', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  get HOSTED() {
    return mode.hosted;
  },
  accessToken: async () => null,
}));

import { LiveProvider } from '../src/api/live';
import { PrefsProvider } from '../src/shell/prefs';
import { RouterProvider } from '../src/shell/router';
import { CardView } from '../src/table/CardView';
import { MAC_ONLY } from '../src/ui-kit/Button';

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
  body: { options: [{ id: 'oc', label: 'Open Orange County' }] },
  status: 'open',
  answer: null,
  answered_by: null,
  answered_at: null,
  created_at: '2026-11-10T08:00:00Z',
  project_name: 'Frequency',
};

function stubFwd() {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).split('?')[0];
    let data: unknown = {};
    if (path === '/v1/decision-cards/dc_open_region') data = CARD;
    else if (path === '/v1/decision-cards') data = [CARD];
    else if (path === '/v1/status')
      data = {
        version: 'test',
        kill: { engaged: false },
        open_cards: 1,
        running_runs: 0,
        oldest_open_card_at: null,
        chain: { ok: true, head_seq: 1, verified_at: new Date().toISOString() },
      };
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

function show() {
  stubFwd();
  history.replaceState(null, '', '/inbox/dc_open_region');
  return render(
    <PrefsProvider>
      <RouterProvider>
        <LiveProvider>
          <CardView
            id="dc_open_region"
            showEvidence={false}
            onToggleEvidence={() => {}}
            onDecided={() => {}}
          />
        </LiveProvider>
      </RouterProvider>
    </PrefsProvider>,
  );
}

describe('card answers on flowweb.app', () => {
  it('are locked with "Only on your Mac" before they are pressed', async () => {
    mode.hosted = true;
    show();
    const snooze = await screen.findByRole('button', { name: /Snooze/ });
    expect((snooze as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Choose/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(MAC_ONLY).length).toBeGreaterThan(0);
  });

  it('stay live on the Mac', async () => {
    mode.hosted = false;
    show();
    const snooze = await screen.findByRole('button', { name: /Snooze/ });
    await waitFor(() => expect((snooze as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(MAC_ONLY)).toBeNull();
  });
});
