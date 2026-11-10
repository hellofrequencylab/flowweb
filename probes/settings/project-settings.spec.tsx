// The Settings checks for FW-C-087; run by probes/settings/project-settings.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { ProjectSettings } from '../../packages/web/src/settings/ProjectSettings';

const now = new Date().toISOString();
const PROJECTS = [
  { id: 'prj_frequency1', slug: 'frequency', name: 'Frequency', kind: 'other', repo_url: null, default_branch: 'main', status: 'active', wip_limit: 1, brand: null, category: null, brief: null },
];
let posts: { url: string; body: Record<string, unknown> }[] = [];

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
      posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return env({});
    }
    if (url.startsWith('/v1/projects')) return env(PROJECTS);
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
      <ProjectSettings canChange={canChange} />
    </LiveProvider>,
  );
const open = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.getByRole('form', { name: 'Brief and labels for Frequency' });
};
const ANSWERS: [string, string][] = [
  ['What is it', 'Local circles.'],
  ['Who is it for', 'Neighbors.'],
  ['How it sounds', 'Warm.'],
  ['What agents must never do', 'Send without me.'],
  ['What done looks like', 'Ten circles.'],
];

describe('Projects in Settings (FW-C-087)', () => {
  it('saves a brief only once all five questions are answered, and sends all five', async () => {
    show();
    const form = await open();
    // The button is looked up again after typing: it moves out of its locked wrapper once it may be pressed.
    const saveBrief = () => within(form).getByRole('button', { name: 'Save brief' }) as HTMLButtonElement;
    expect(saveBrief().disabled).toBe(true);
    for (const [label, value] of ANSWERS)
      fireEvent.change(within(form).getByRole('textbox', { name: new RegExp(`^${label}`) }), { target: { value } });
    const save = saveBrief();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe('/v1/projects/prj_frequency1/brief');
    expect(posts[0].body).toEqual({ what: 'Local circles.', who: 'Neighbors.', voice: 'Warm.', never: 'Send without me.', done: 'Ten circles.' });
    await waitFor(() => expect(form.textContent).toMatch(/Brief saved/));
  });

  it('saves the brand and category', async () => {
    show();
    const form = await open();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Brand' }), { target: { value: 'Frequency' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Category' }), { target: { value: 'marketing' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save labels' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe('/v1/projects/prj_frequency1/labels');
    expect(posts[0].body).toEqual({ brand: 'Frequency', category: 'marketing' });
  });

  it('a helper or viewer can read the brief but not change it', async () => {
    show(false);
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const form = screen.getByRole('form', { name: 'Brief and labels for Frequency' });
    expect((within(form).getByRole('textbox', { name: /^What is it/ }) as HTMLTextAreaElement).readOnly).toBe(true);
    expect((within(form).getByRole('button', { name: 'Save brief' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByRole('button', { name: 'Save labels' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
