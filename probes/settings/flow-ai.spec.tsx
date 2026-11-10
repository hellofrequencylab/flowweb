// The Settings checks for FW-C-086; run by probes/settings/flow-ai.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub. HOSTED is switched off: the section takes hosted
// as a prop, and the machine list answers the account test the relay would copy.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { AiSettings } from '../../packages/web/src/settings/AiSettings';

const now = new Date().toISOString();
const flow = (key: string, name: string, ai: unknown) => ({
  key,
  name,
  enabled: true,
  dial: 'draft',
  tier: 'L1',
  state: 'ready',
  gate: null,
  reason: '',
  open_asks: 0,
  budget: null,
  ai,
});
const SUP = {
  kill_switch: false,
  paused: false,
  max_concurrent: 1,
  running: 0,
  gates: [],
  next: [],
  flows: [
    flow('neighborhood-activation', 'Neighborhood activation', { adapter: 'codex', auth: 'signin', chosen: false }),
    flow('local-saturation', 'Local saturation', null),
  ],
};
const MACHINES = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    label: 'Test Mac',
    created_at: now,
    last_seen_at: now,
    revoked_at: null,
    report: {
      account_test: {
        checked_at: now,
        start_command: null,
        accounts: {
          codex_signin: { set_up: true, ok: false, detail: 'expired', fix: 'Run codex login.' },
          claude_signin: { set_up: true, ok: true, detail: null, fix: null },
        },
      },
    },
  },
];

let posts: { url: string; body: unknown }[] = [];
beforeEach(() => {
  posts = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const env = (data: unknown) =>
      new Response(JSON.stringify({ data, as_of: now, head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return env({ changed: true });
    }
    if (url === '/v1/supervisor') return env(SUP);
    if (url === '/v1/hosted/machines') return env(MACHINES);
    return env({});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (canChange = true) =>
  render(
    <LiveProvider>
      <AiSettings hosted={true} canChange={canChange} />
    </LiveProvider>,
  );
const group = (name: string) => screen.getByRole('group', { name: `AI account for ${name}` });

describe('AI for each flow (FW-C-086)', () => {
  it('lists every flow with the account it uses now checked', async () => {
    show();
    await screen.findByRole('heading', { name: /^AI for each flow/ });
    await waitFor(() => group('Neighborhood activation'));
    const na = group('Neighborhood activation');
    expect((within(na).getByRole('radio', { name: 'ChatGPT plan' }) as HTMLInputElement).checked).toBe(true);
    expect(na.textContent).toMatch(/From the flow's setup/);
    const ls = group('Local saturation');
    expect(within(ls).getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(ls.textContent).toMatch(/Not chosen yet/);
  });

  it('picking an account sends only that account to the flow', async () => {
    show();
    await waitFor(() => group('Neighborhood activation'));
    fireEvent.click(within(group('Neighborhood activation')).getByRole('radio', { name: 'Claude plan' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe('/v1/supervisor/flows/neighborhood-activation/ai');
    expect(posts[0].body).toEqual({ account: 'claude_plan' });
    await waitFor(() => expect(group('Neighborhood activation').textContent).toMatch(/now uses your Claude plan/));
  });

  it('says when the account a flow uses failed its last test', async () => {
    show();
    await waitFor(() => expect(group('Neighborhood activation').textContent).toMatch(/failed its last test/));
  });

  it('a helper or viewer sees the choice but cannot change it', async () => {
    show(false);
    await waitFor(() => group('Neighborhood activation'));
    const radios = within(group('Neighborhood activation')).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.every((r) => r.disabled)).toBe(true);
    fireEvent.click(radios[0]);
    expect(posts.length).toBe(0);
  });
});
