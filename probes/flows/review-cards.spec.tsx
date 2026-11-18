// The component checks for FW-C-168; run by probes/flows/review-cards.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers the summary and proposals routes with fwd's envelope and
// records each POST.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { WhatsWorking } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const S = `/v1/flows/${KEY}/review/summary`;
const P = `/v1/flows/${KEY}/review/proposals`;

const SUMMARY = {
  flow: KEY,
  state: 'thin',
  at: '2026-11-09T06:00:00.000Z',
  week: '2026-W46',
  min_sent: 8,
  sample_ok: false,
  totals: { sent: 3, replied: 1, signups: 0, reply_rate: 1 / 3, signup_rate: 0 },
  dimensions: [],
  learnings: [],
};
const PAUSE = {
  id: 'shf_aaaaaaaaaaaa',
  kind: 'pause',
  text: 'Pause the hunt "Chess clubs": 16 sent and nothing back.',
  evidence: { pooled_rate: 0.16, hunts: [{ name: 'Chess clubs', sent: 16, responded: 0, from: null, to: null }] },
  state: 'open',
};
const MOVE = {
  id: 'shf_bbbbbbbbbbbb',
  kind: 'move',
  text: 'Move sends toward the hunts that get replies: "Sound baths" from 10 to 16 a run, "Open mics" from 10 to 3 a run.',
  evidence: {
    pooled_rate: 0.16,
    hunts: [
      { name: 'Sound baths', sent: 20, responded: 8, from: 10, to: 16 },
      { name: 'Open mics', sent: 20, responded: 1, from: 10, to: 3 },
    ],
  },
  state: 'open',
};
const OLD = { ...PAUSE, id: 'shf_cccccccccccc', text: 'Pause the hunt "Book clubs": 15 sent and nothing back.', state: 'declined' };

function stubFwd(proposals: unknown[] | null) {
  const posts: { url: string; body: unknown }[] = [];
  let list = proposals;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    let data: unknown = {};
    if ((init.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      posts.push({ url, body });
      const id = url.split('/').pop();
      const state = body.decision === 'accept' ? 'accepted' : 'declined';
      list = (list ?? []).map((p) => ((p as { id: string }).id === id ? { ...(p as object), state } : p));
      data = (list ?? []).find((p) => (p as { id: string }).id === id) ?? {};
    } else if (url === S) data = SUMMARY;
    else if (url === P && list) data = { flow: KEY, proposals: list };
    return new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return posts;
}

async function mount(proposals: unknown[] | null) {
  const posts = stubFwd(proposals);
  render(
    <LiveProvider>
      <WhatsWorking flow={KEY} />
    </LiveProvider>,
  );
  const region = await screen.findByRole('region', { name: /what's working/i });
  await waitFor(() => expect(region.textContent).toMatch(/too few/i));
  return { region, posts };
}
const cards = (region: HTMLElement) => within(region).queryAllByRole('article');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FW-C-168 review cards', () => {
  it('shows each open proposal as a card with its evidence, Accept and Decline', async () => {
    const { region } = await mount([PAUSE, MOVE, OLD]);
    await waitFor(() => expect(cards(region).length).toBe(2));
    const [pause, move] = cards(region);
    expect(pause.textContent).toContain('Pause the hunt "Chess clubs"');
    expect(pause.textContent).toMatch(/0 of 16/);
    expect(move.textContent).toMatch(/8 of 20/);
    for (const c of cards(region)) {
      expect(within(c).getByRole('button', { name: 'Accept' })).toBeTruthy();
      expect(within(c).getByRole('button', { name: 'Decline' })).toBeTruthy();
    }
    expect(region.textContent).not.toContain('Book clubs');
    expect(region.textContent).not.toMatch(/[–—]/);
  });

  it('Accept sends the decision for that proposal and the card goes away', async () => {
    const { region, posts } = await mount([PAUSE, MOVE]);
    await waitFor(() => expect(cards(region).length).toBe(2));
    fireEvent.click(within(cards(region)[1]).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe(`${P}/${MOVE.id}`);
    expect(posts[0].body).toEqual({ decision: 'accept' });
    await waitFor(() => expect(cards(region).length).toBe(1));
    expect(within(region).getByRole('status').textContent).toMatch(/accepted/i);
    expect(cards(region)[0].textContent).toContain('Chess clubs');
  });

  it('Decline sends decline and says it will not come up again for 30 days', async () => {
    const { region, posts } = await mount([PAUSE]);
    await waitFor(() => expect(cards(region).length).toBe(1));
    fireEvent.click(within(cards(region)[0]).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe(`${P}/${PAUSE.id}`);
    expect(posts[0].body).toEqual({ decision: 'decline' });
    await waitFor(() => expect(cards(region).length).toBe(0));
    expect(within(region).getByRole('status').textContent).toMatch(/30 days/);
  });

  it('shows no card and no button when nothing is open, or when fwd has no proposals yet', async () => {
    const a = await mount([OLD]);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(cards(a.region).length).toBe(0);
    expect(within(a.region).queryByRole('button', { name: 'Accept' })).toBeNull();
    cleanup();
    const b = await mount(null);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(cards(b.region).length).toBe(0);
    expect(within(b.region).queryByRole('button', { name: 'Decline' })).toBeNull();
  });
});
