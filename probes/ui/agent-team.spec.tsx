// The Team page checks for FW-C-123; run by probes/ui/agent-team.mjs (not on its own). Tier 0.
// fwd (or the hosted /v1) is stood in by a fetch stub answering GET /v1/team.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { TeamPage } from '../../packages/web/src/team/TeamPage';

const now = new Date().toISOString();
const card = (id: string, level: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  level,
  department: null,
  title: `${name} title`,
  name,
  default_name: name,
  archetype: level === 'building' ? null : `The ${id} archetype`,
  voice: level === 'building' ? null : `${name} voice`,
  default_voice: level === 'building' ? null : `${name} voice`,
  says: level === 'building' ? null : `${name} says hello.`,
  cares_about: level === 'building' ? null : `${name} cares`,
  judged_on: level === 'building' ? null : `${name} number`,
  never: level === 'building' ? null : `${name} never`,
  escalates: level === 'building' ? null : `${name} escalates`,
  tier: level === 'building' ? 'none' : 'small',
  face: level === 'building' ? null : 'spark',
  reports_to: 'ceo',
  flows: [],
  status: 'working',
  ...extra,
});
const members = (ceo: string) => [
  card('ceo', 'ceo', ceo, { reports_to: null, title: 'CEO' }),
  card('coo', 'exec', 'The COO', { title: 'COO, Operations', department: 'operations' }),
  card('cmo', 'exec', 'The CMO', { title: 'CMO, Marketing', department: 'marketing' }),
  card('connector', 'manager', 'The Connector', { department: 'marketing', reports_to: 'cmo' }),
  card('closer', 'manager', 'The Closer', { department: 'sales', reports_to: 'ceo', status: 'bench' }),
  card('editor', 'staff', 'The Editor', { reports_to: 'coo' }),
  card('code', 'contractor', 'Code contractor', { reports_to: 'cto' }),
  card('watchdog', 'building', 'Watchdog', { reports_to: 'coo' }),
];
let posts: { url: string; body: unknown }[] = [];
let teams: unknown[] = [];
beforeEach(() => {
  posts = [];
  teams = [
    { key: 'main', brand: null, label: 'Your team', members: members('Kevin') },
    { key: 'frequency', brand: 'Frequency', label: 'Frequency', members: members('Juniper') },
  ];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const env = (data: unknown) =>
      new Response(JSON.stringify({ data, as_of: now, head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if ((init.method ?? 'GET') === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return env({ changed: true });
    }
    if (url === '/v1/team') return env({ teams });
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
      <TeamPage />
    </LiveProvider>,
  );
const agent = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });

describe('Team page (FW-C-123)', () => {
  it('shows the org chart by level with the CEO on top', async () => {
    show();
    await waitFor(() => agent('Kevin'));
    for (const h of ['CEO', 'Exec team', 'Managers', 'Staff', 'Contractors', 'The building'])
      expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    expect(agent('The Connector')).toBeTruthy();
    expect(screen.getByText('Watchdog')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[–—]/);
  });

  it('switches to the Frequency team and its CEO', async () => {
    show();
    await waitFor(() => agent('Kevin'));
    fireEvent.click(screen.getByRole('tab', { name: /Frequency/ }));
    await waitFor(() => agent('Juniper'));
    expect(screen.queryByRole('button', { name: /^Kevin\b/ })).toBeNull();
  });

  it('opens a profile with the personality card, its boss and the bench', async () => {
    show();
    await waitFor(() => agent('The Connector'));
    fireEvent.click(agent('The Connector'));
    const p = await screen.findByRole('region', { name: 'The Connector' });
    for (const t of ['The connector archetype', 'The Connector voice', 'The Connector says hello.', 'The Connector number', 'The Connector never'])
      expect(within(p).getByText(t, { exact: false })).toBeTruthy();
    expect(within(p).getByText(/Reports to/).textContent).toMatch(/The CMO/);
    fireEvent.click(agent('The Closer'));
    const q = await screen.findByRole('region', { name: 'The Closer' });
    expect(q.textContent).toMatch(/Not hired yet/);
  });

  it('renaming the CEO posts only { name } to its team', async () => {
    show();
    await waitFor(() => agent('Kevin'));
    fireEvent.click(agent('Kevin'));
    const p = await screen.findByRole('region', { name: 'Kevin' });
    fireEvent.click(within(p).getByRole('button', { name: 'Rename' }));
    fireEvent.change(within(p).getByRole('textbox', { name: 'Name' }), { target: { value: 'Ada' } });
    fireEvent.click(within(p).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe('/v1/team/main/ceo');
    expect(posts[0].body).toEqual({ name: 'Ada' });
  });
});
