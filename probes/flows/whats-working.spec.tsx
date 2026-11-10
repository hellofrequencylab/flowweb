// The component checks for FW-C-072; run by probes/flows/whats-working.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers the summary route with fwd's envelope.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { WhatsWorking } from '../../packages/web/src/flows';

const KEY = 'neighborhood-activation';
const S = `/v1/flows/${KEY}/review/summary`;

const item = (name: string, sent: number, replied: number, signups: number) => ({
  value: name,
  name,
  sent,
  replied,
  signups,
  reply_rate: sent ? replied / sent : null,
  signup_rate: sent ? signups / sent : null,
});
const dim = (key: string, label: string, over: Record<string, unknown> = {}) => ({
  key,
  label,
  tracked: true,
  judged: 0,
  best: null,
  worst: null,
  ...over,
});
const base = {
  flow: KEY,
  min_sent: 8,
  learnings: ['"Sound baths" works best: 6 of 12 sent responded, 2 became members.'],
};

const READY = {
  ...base,
  state: 'ready',
  at: '2026-11-09T06:00:00.000Z',
  week: '2026-W46',
  sample_ok: true,
  totals: { sent: 31, replied: 7, signups: 2, reply_rate: 7 / 31, signup_rate: 2 / 31 },
  dimensions: [
    dim('source', 'Source', { judged: 2, best: item('eventbrite.com', 12, 6, 2), worst: item('meetup.com', 19, 1, 0) }),
    dim('hunt', 'Hunt', { judged: 2, best: item('Sound baths', 12, 6, 2), worst: item('Chess clubs', 19, 1, 0) }),
    dim('funnel', 'Funnel', { judged: 1, best: item('host', 31, 7, 2) }),
    dim('sub_area', 'Sub-area', { judged: 2, best: item('leucadia', 12, 6, 2), worst: item('carlsbad-village', 16, 0, 0) }),
    dim('angle', 'Message angle', { tracked: false }),
  ],
};
const THIN = {
  ...base,
  state: 'thin',
  at: '2026-11-09T06:00:00.000Z',
  week: '2026-W46',
  sample_ok: false,
  totals: { sent: 3, replied: 1, signups: 0, reply_rate: 1 / 3, signup_rate: 0 },
  dimensions: [dim('source', 'Source'), dim('hunt', 'Hunt'), dim('funnel', 'Funnel'), dim('sub_area', 'Sub-area'), dim('angle', 'Message angle')],
};
const NONE = {
  ...base,
  state: 'none',
  at: null,
  week: null,
  sample_ok: false,
  learnings: [],
  totals: { sent: 0, replied: 0, signups: 0, reply_rate: null, signup_rate: null },
  dimensions: [],
};

function stubFwd(summary: unknown) {
  vi.stubGlobal('fetch', async (url: string) => {
    const data = url === S ? summary : {};
    return new Response(JSON.stringify({ data, as_of: new Date().toISOString(), head_seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const mount = () =>
  render(
    <LiveProvider>
      <WhatsWorking flow={KEY} />
    </LiveProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FW-C-072 what's working", () => {
  it('shows the best hunt and source with their counts in a few plain lines', async () => {
    stubFwd(READY);
    mount();
    const region = await screen.findByRole('region', { name: /what's working/i });
    await waitFor(() => expect(region.textContent).toMatch(/Best hunt: Sound baths, 6 of 12 replied/));
    expect(region.textContent).toMatch(/Best source: eventbrite\.com, 6 of 12 replied/);
    const lines = within(region).getAllByRole('listitem');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('names the weakest value and says which dimensions are not tracked yet', async () => {
    stubFwd(READY);
    mount();
    const region = await screen.findByRole('region', { name: /what's working/i });
    await waitFor(() => expect(region.textContent).toMatch(/Chess clubs|meetup\.com|carlsbad-village/));
    expect(region.textContent).toMatch(/message angle[^.]*not tracked yet/i);
  });

  it('says so honestly when there is no review yet', async () => {
    stubFwd(NONE);
    mount();
    const region = await screen.findByRole('region', { name: /what's working/i });
    await waitFor(() => expect(region.textContent).toMatch(/no weekly review yet/i));
    expect(region.textContent).not.toMatch(/Best /);
  });

  it('says the sample is too small instead of naming a winner', async () => {
    stubFwd(THIN);
    mount();
    const region = await screen.findByRole('region', { name: /what's working/i });
    await waitFor(() => expect(region.textContent).toMatch(/too few/i));
    expect(region.textContent).toMatch(/\b8\b/);
    expect(region.textContent).toMatch(/3 sent/);
    expect(region.textContent).not.toMatch(/Best /);
  });
});
