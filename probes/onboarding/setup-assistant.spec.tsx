// The component checks for FW-C-085; run by probes/onboarding/setup-assistant.mjs (not on its own). Tier 0.
// The live site is stood in by a fetch stub: /v1/hosted/machines answers what the machine last reported,
// /v1/setup answers the mirrored setup steps (or 404 before any machine pushed), and
// /v1/assistant/setup answers the site's AI (or 503 when the site has none).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { SetupAssistant } from '../../packages/web/src/setup/SetupAssistant';
import { RouterProvider } from '../../packages/web/src/shell/router';

const KEY = `sk-ant-oat01-${'A1b2C3d4'.repeat(6)}`;
const now = new Date().toISOString();

type Test = { set_up: boolean | null; ok: boolean | null; detail: string | null; fix: string | null };
const machine = (tests: Record<string, Test> | null) => ({
  id: '00000000-0000-0000-0000-000000000001',
  label: 'Test Mac',
  created_at: now,
  last_seen_at: now,
  revoked_at: null,
  report: { label: 'Test Mac', ...(tests ? { account_test: { checked_at: now, accounts: tests, start_command: null } } : {}) },
});

const SETUP = {
  ready: false,
  next: 'project',
  fwd: 'up',
  checked_at: now,
  steps: [
    { id: 'machine', title: 'FlowWeb runs on this machine', required: true, done: true, detail: '', fix: null },
    { id: 'sign_ins', title: 'Sign in an AI account', required: true, done: false, detail: '', fix: null },
    { id: 'project', title: 'Add your project', required: true, done: false, detail: '', fix: 'pnpm fw project add my-business' },
  ],
};

type Call = { method: string; url: string; body: string };
let calls: Call[] = [];
let machines: unknown[] = [];
let setup: unknown = null;
let assistant: 'answers' | 'down' = 'answers';

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, as_of: now, head_seq: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const failure = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function stubSite() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? String(init.body) : '' });
    if (url.endsWith('/v1/hosted/machines')) return envelope(machines);
    if (url.endsWith('/v1/setup')) return setup ? envelope(setup) : failure(404, 'not_found');
    if (url.endsWith('/v1/assistant/setup'))
      return assistant === 'answers'
        ? envelope({ answer: 'From the site AI: start with the plan you already pay for.' })
        : failure(503, 'not_configured');
    return envelope({});
  });
}

beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
  machines = [];
  setup = null;
  assistant = 'answers';
  stubSite();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <RouterProvider>
      <LiveProvider>
        <SetupAssistant hosted={true} />
      </LiveProvider>
    </RouterProvider>,
  );
const guide = () => screen.getByRole('status', { name: 'What to do next' });
const ask = (text: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask the setup assistant' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
};

describe('setup assistant (FW-C-085)', () => {
  it('with no machine yet, says how to put FlowWeb on one and points at Settings', async () => {
    show();
    await waitFor(() => expect(guide().textContent).toMatch(/needs a computer to run on/));
    expect(guide().textContent).toContain('pnpm install');
    expect(within(guide()).getByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('with a machine and no AI, asks which account and gives the command for it', async () => {
    machines = [machine(null)];
    show();
    await waitFor(() => expect(guide().textContent).toMatch(/Which one do you have\?/));
    fireEvent.click(within(guide()).getByRole('button', { name: 'Claude Pro or Max' }));
    expect(guide().textContent).toContain('pnpm fw accounts connect --only claude');
    expect(guide().textContent).toMatch(/never into this page/);
  });

  it('refuses a pasted key: not shown, not stored, not sent', async () => {
    show();
    await waitFor(() => guide());
    ask(`here is my key ${KEY}`);
    expect(screen.getByRole('alert').textContent).toMatch(/looks like a key/);
    expect(document.body.textContent).not.toContain(KEY);
    expect(screen.queryByRole('log', { name: 'Setup conversation' })).toBeNull();
    let stored = '';
    try {
      stored = JSON.stringify({ ...sessionStorage });
    } catch {
      /* no storage */
    }
    expect(stored).not.toContain('sk-ant-');
    expect(calls.some((c) => c.body.includes('sk-ant-'))).toBe(false);
  });

  it('when the machine reports a working account, says so and names the next step', async () => {
    machines = [machine({ claude_signin: { set_up: true, ok: true, detail: null, fix: null } })];
    setup = SETUP;
    show();
    await waitFor(() => expect(guide().textContent).toMatch(/Your AI works: Claude plan/));
    expect(guide().textContent).toContain('Add your project');
    expect(guide().textContent).toContain('pnpm fw project add my-business');
  });

  it('when the account test failed, shows the fix and how to test again', async () => {
    machines = [
      machine({ codex_signin: { set_up: true, ok: false, detail: 'expired', fix: 'Run codex login again.' } }),
    ];
    show();
    await waitFor(() => expect(guide().textContent).toMatch(/did not work yet: ChatGPT plan/));
    expect(guide().textContent).toContain('Run codex login again.');
    expect(guide().textContent).toContain('pnpm fw accounts check');
  });

  it("asks the site's AI a question and shows its answer", async () => {
    show();
    await waitFor(() => guide());
    ask('Which AI should I use?');
    const log = await screen.findByRole('log', { name: 'Setup conversation' });
    await waitFor(() => expect(log.textContent).toContain('From the site AI'));
    expect(log.textContent).toContain('Which AI should I use?');
    const sent = calls.find((c) => c.url.endsWith('/v1/assistant/setup'));
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(sent?.body ?? '{}').question).toBe('Which AI should I use?');
  });

  it('answers from what it knows when the site has no AI', async () => {
    assistant = 'down';
    show();
    await waitFor(() => guide());
    ask('How much does this cost?');
    const log = await screen.findByRole('log', { name: 'Setup conversation' });
    await waitFor(() => expect(log.textContent).toMatch(/nothing extra to pay/));
  });
});
