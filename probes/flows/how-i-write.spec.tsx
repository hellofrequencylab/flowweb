// The Settings checks for FW-C-167; run by probes/flows/how-i-write.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub. On the site a save answers 202 with a request id and
// the page waits for the relay to finish it; `queue` switches the stub to that.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { PrefsProvider } from '../../packages/web/src/shell/prefs';
import { SettingsPage } from '../../packages/web/src/settings/SettingsPage';
import { VoiceSettings } from '../../packages/web/src/settings/VoiceSettings';

const ORIGINAL = 'Write the way I wrote this one myself:\n\nHi Mirabai, your Encinitas kirtan caught my eye.';
const MINE = 'Short and warm, like a neighbor would write.';
const now = new Date().toISOString();
let voice = { note: ORIGINAL, saved: false, updated_at: null as string | null, edits: 0 };
let posts: { url: string; body: { note?: string } }[] = [];
let asked: string[] = [];
let queue = false;

beforeEach(() => {
  voice = { note: ORIGINAL, saved: false, updated_at: null, edits: 0 };
  posts = [];
  asked = [];
  queue = false;
  localStorage.clear();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const env = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data, as_of: now, head_seq: 1 }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const apply = (note: string) => {
      voice = note === '' ? { ...voice, note: ORIGINAL, saved: false } : { ...voice, note, saved: true, updated_at: now };
    };
    if (method === 'POST' && url === '/v1/voice') {
      const body = JSON.parse(String(init.body ?? '{}'));
      posts.push({ url, body });
      if (queue) return env({ request_id: 'req_1', status: 'queued' }, 202);
      apply(String(body.note));
      return env(voice);
    }
    if (method === 'GET' && url === '/v1/voice') return env(voice);
    if (method === 'GET' && url === '/v1/hosted/requests/req_1') {
      asked.push(url);
      apply(String(posts[posts.length - 1]?.body.note));
      return env({ status: 'done', result: voice, error: null });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here', details: {} } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <LiveProvider>
      <VoiceSettings />
    </LiveProvider>,
  );
const form = () => screen.getByRole('form', { name: 'How I write' });
const box = () => within(form()).getByRole('textbox', { name: /How I write/ }) as HTMLTextAreaElement;
const button = (name: string) => within(form()).getByRole('button', { name }) as HTMLButtonElement;

describe('How I write (FW-C-167)', () => {
  it('Settings shows the panel with the original, what it does, and that it never sends', async () => {
    render(
      <PrefsProvider>
        <LiveProvider>
          <SettingsPage pairedAt={now} onSignedOut={() => {}} onOpenKill={() => {}} />
        </LiveProvider>
      </PrefsProvider>,
    );
    expect(await screen.findByRole('heading', { level: 2, name: /^How I write/ })).toBeTruthy();
    await waitFor(() => expect(box().value).toBe(ORIGINAL));
    expect(form().textContent).toMatch(/Every new draft and every AI rewrite follows this note/);
    expect(form().textContent).toMatch(/never sends anything/);
    expect(form().textContent).toMatch(/original that shipped/);
    expect(form().textContent).not.toMatch(/kept to learn from/);
    expect(button('Back to the original').disabled).toBe(true);
    expect(form().textContent).not.toMatch(/[–—]|Midnight/);
  });

  it('Save posts only the note, and the box then holds the saved note', async () => {
    show();
    await waitFor(() => expect(box().value).toBe(ORIGINAL));
    fireEvent.change(box(), { target: { value: `  ${MINE}  ` } });
    fireEvent.click(button('Save'));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual({ url: '/v1/voice', body: { note: MINE } });
    await waitFor(() => expect(form().textContent).toMatch(/Saved\. New drafts and rewrites follow it\./));
    await waitFor(() => expect(box().value).toBe(MINE));
    expect(form().textContent).toMatch(/This is your saved note/);
    // A long dash is caught before anything is asked of the machine.
    fireEvent.change(box(), { target: { value: 'Warm — never stiff.' } });
    expect(button('Save').disabled).toBe(true);
    expect(form().textContent).toMatch(/Use a comma or a new sentence/);
    expect(posts.length).toBe(1);
  });

  it('on the site the save is queued, waits for the machine, and then shows as saved', async () => {
    queue = true;
    show();
    await waitFor(() => expect(box().value).toBe(ORIGINAL));
    fireEvent.change(box(), { target: { value: MINE } });
    fireEvent.click(button('Save'));
    await waitFor(() => expect(form().textContent).toMatch(/Waiting for your machine to apply it/));
    expect(posts).toEqual([{ url: '/v1/voice', body: { note: MINE } }]);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 10000 });
    await waitFor(() => expect(form().textContent).toMatch(/Saved\. New drafts and rewrites follow it\./), { timeout: 10000 });
    await waitFor(() => expect(box().value).toBe(MINE));
  });

  it('shows how many edits are kept, and Back to the original clears the saved note', async () => {
    voice = { note: MINE, saved: true, updated_at: now, edits: 12 };
    show();
    await waitFor(() => expect(box().value).toBe(MINE));
    expect(form().textContent).toMatch(/12 of your edits kept to learn from\./);
    fireEvent.click(button('Back to the original'));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].body).toEqual({ note: '' });
    await waitFor(() => expect(box().value).toBe(ORIGINAL));
    expect(form().textContent).toMatch(/Back to the original\./);
  });
});
