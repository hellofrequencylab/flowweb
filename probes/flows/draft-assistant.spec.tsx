// The component checks for FW-C-076; run by probes/flows/draft-assistant.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers each route with fwd's envelope. Each rewrite answers the
// next numbered version; the instruction "FAIL" answers fwd's 409 engine_failed.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { DraftsInbox } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const D = `/v1/supervisor/flows/${KEY}/drafts`;

const draft = (id: string, subject: string, body: string, created: string) => ({
  id,
  fire_id: 'f_1',
  lead_id: `lead:${id}`,
  channel: 'founder_email',
  subject,
  body,
  status: 'waiting_for_owner',
  created_at: created,
});

const DRAFTS = [
  draft('d_new', 'Newest ready note', 'Hi Front Porch Gallery, the original note.', '2026-11-10T10:00:00Z'),
  draft('d_old', 'Older ready note', 'Hi Old Town Garden Club, an older note.', '2026-11-08T10:00:00Z'),
];

type Call = { method: string; url: string; body: Record<string, string> | undefined };
let calls: Call[] = [];
let n = 0;

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function stubFwd() {
  calls = [];
  n = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url === D) return envelope(DRAFTS);
    if (method === 'POST' && url.endsWith('/rewrite')) {
      if (body?.instruction === 'FAIL')
        return new Response(
          JSON.stringify({ error: { code: 'engine_failed', message: 'The AI did not write a rewrite.' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      n += 1;
      return envelope({ id: 'd_new', subject: `Version ${n}`, body: `Rewritten note ${n}.`, instruction: body?.instruction });
    }
    if (method === 'POST' && url.endsWith('/edit')) return envelope({ ...DRAFTS[0], ...body });
    return envelope({});
  });
}

beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <LiveProvider>
      <DraftsInbox flow={KEY} />
    </LiveProvider>,
  );
const viewer = () => screen.getByRole('region', { name: 'Draft viewer' });
const chat = () => within(viewer()).getByRole('log', { name: 'AI conversation' });
const message = () => within(viewer()).getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const subjectBox = () => within(viewer()).getByRole('textbox', { name: 'Subject' }) as HTMLInputElement;
const rewrites = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/rewrite'));

async function opened() {
  show();
  await screen.findByRole('listbox', { name: 'All drafts' });
  await waitFor(() => expect(viewer().textContent).toContain('the original note'));
}

async function ask(text: string, expectBody: string | null) {
  const before = rewrites().length;
  const box = within(viewer()).getByRole('textbox', { name: 'Tell AI how to rewrite this draft' });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(within(viewer()).getByRole('button', { name: 'Rewrite' }));
  await waitFor(() => expect(rewrites().length).toBe(before + 1));
  if (expectBody) await waitFor(() => expect(message().value).toBe(expectBody));
}

describe('DraftAssistant', () => {
  it('shows your ask and the AI version in the conversation, and puts the rewrite in the editor unsaved', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    expect(subjectBox().value).toBe('Version 1');
    expect(chat().textContent).toContain('Make it warmer');
    expect(chat().textContent).toContain('Rewritten note 1.');
    expect(calls.some((c) => c.url.endsWith('/edit'))).toBe(false);
  });

  it('rewrites the latest version when you ask a follow-up', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    await ask('Now shorter', 'Rewritten note 2.');
    const second = rewrites()[1].body ?? {};
    expect(second.instruction).toBe('Now shorter');
    expect(second.body).toBe('Rewritten note 1.');
    expect(second.subject).toBe('Version 1');
    expect(chat().textContent).toContain('Now shorter');
    expect(chat().textContent).toContain('Rewritten note 2.');
  });

  it('undoes the last rewrite and can go back to the original', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    await ask('Now shorter', 'Rewritten note 2.');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Undo last rewrite' }));
    await waitFor(() => expect(message().value).toBe('Rewritten note 1.'));
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Back to the original' }));
    await waitFor(() => expect(message().value).toBe('Hi Front Porch Gallery, the original note.'));
    expect(subjectBox().value).toBe('Newest ready note');
  });

  it('puts an earlier version back with Use this version', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    await ask('Now shorter', 'Rewritten note 2.');
    const uses = within(chat()).getAllByRole('button', { name: 'Use this version' });
    expect(uses.length).toBe(2);
    fireEvent.click(uses[0]);
    await waitFor(() => expect(message().value).toBe('Rewritten note 1.'));
    expect(subjectBox().value).toBe('Version 1');
  });

  it('shows a failed rewrite in the conversation and keeps the text', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    await ask('FAIL', null);
    await waitFor(() => expect(chat().textContent).toContain('The AI did not write a rewrite.'));
    expect(message().value).toBe('Rewritten note 1.');
  });

  it('keeps the conversation when you open another draft and come back', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    const list = screen.getByRole('listbox', { name: 'All drafts' });
    const pick = (s: string) => {
      const o = within(list)
        .getAllByRole('option')
        .find((x) => (x.textContent ?? '').includes(s));
      if (!o) throw new Error(`no option for ${s}`);
      fireEvent.click(o);
    };
    pick('Older ready note');
    await waitFor(() => expect(viewer().textContent).toContain('Old Town Garden Club'));
    expect(viewer().textContent).not.toContain('Make it warmer');
    pick('Newest ready note');
    await waitFor(() => expect(chat().textContent).toContain('Make it warmer'));
    expect(chat().textContent).toContain('Rewritten note 1.');
  });

  it('saves the version you kept only when you press Save', async () => {
    stubFwd();
    await opened();
    await ask('Make it warmer', 'Rewritten note 1.');
    fireEvent.click(within(viewer()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${D}/d_new/edit`)).toBe(true));
    const edit = calls.find((c) => c.url === `${D}/d_new/edit`)?.body ?? {};
    expect(edit.body).toBe('Rewritten note 1.');
    expect(edit.subject).toBe('Version 1');
  });
});
