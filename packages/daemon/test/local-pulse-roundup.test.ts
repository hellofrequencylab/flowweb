import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type PulseConfig, type UpcomingEvent } from '../src/flows/local-pulse.ts';
import { draftRoundup, runRoundup } from '../src/flows/local-pulse-roundup.ts';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const NOW = new Date('2026-11-12T16:00:00Z');
const homes: string[] = [];
const home = () => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'fw-local-pulse-')));
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const cfg = (): PulseConfig => ({
  ...(loadConfig(REPO_ROOT, '/nonexistent') as PulseConfig),
  groups: [
    { name: 'Open Board', url: 'https://example.com/a', allows_promo: true, last_posted_at: null },
    {
      name: 'Recent Board',
      url: 'https://example.com/b',
      allows_promo: true,
      last_posted_at: '2026-11-09T16:00:00Z',
    },
    { name: 'No Ads Board', url: 'https://example.com/c', allows_promo: false, last_posted_at: null },
  ],
});
const ev = (id: string, town: string, days: number, extra: Partial<UpcomingEvent> = {}): UpcomingEvent => ({
  event_id: id,
  title: `Event ${id}`,
  starts_at: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
  town,
  niche: 'sound-bath',
  rsvp_url: `https://frequencylocal.com/e/${id}`,
  ...extra,
});

describe('local pulse roundup (FW-C-107)', () => {
  it('drafts an email, a caption, eligible group posts and one heads-up per host, without dashes', () => {
    const events = [
      ev('a', 'Encinitas', 1, { host_id: 'h1', first_name: 'Ana' }),
      ev('b', 'Carlsbad', 2, { host_id: 'h1' }),
      ev('c', 'Del Mar', 3),
    ];
    const { drafts, groups } = draftRoundup(cfg(), events, home(), NOW);
    expect(drafts.map((d) => d.channel)).toEqual([
      'members_email',
      'instagram',
      'local_group',
      'heads_up',
      'heads_up',
    ]);
    expect(groups.map((g) => g.status)).toEqual(['drafted', 'posted_recently', 'no_promo']);
    const email = drafts[0]?.body ?? '';
    expect(email).toContain('Daniel Tyack\nFounder\nfrequencylocal.com');
    expect(email).toContain('P.S.');
    expect(email).toContain('utm_source=flowweb');
    expect(email).toContain('utm_content=sound-bath.lp-20261112-email');
    for (const d of drafts) expect(`${d.subject} ${d.body}`).not.toMatch(/[–—]/);
    expect(drafts[3]?.body).toMatch(/^Hi Ana, /);
    expect(drafts[3]?.body).toContain('utm_medium=one-to-one');
    expect(draftRoundup(cfg(), [], home(), NOW).drafts).toEqual([]);
  });

  it('counts a group draft the Owner marked sent as a recent post', () => {
    const h = home();
    mkdirSync(join(h, 'flows/local-pulse/drafts'), { recursive: true });
    writeFileSync(
      join(h, 'flows/local-pulse/drafts/old.json'),
      JSON.stringify({ id: 'old', lead_id: 'group:open-board', sent_at: '2026-11-10T00:00:00Z' }),
    );
    expect(draftRoundup(cfg(), [ev('a', 'Encinitas', 1)], h, NOW).groups[0]?.status).toBe('posted_recently');
  });

  it('keeps a draft the Owner edited when the roundup runs again', async () => {
    const h = home();
    mkdirSync(join(h, 'flows/local-pulse'), { recursive: true });
    writeFileSync(
      join(h, 'flows/local-pulse/upcoming.json'),
      JSON.stringify({ events: [ev('a', 'Encinitas', 1)] }),
    );
    const first = await runRoundup({ repoRoot: REPO_ROOT, fwHome: h, env: {}, now: NOW });
    expect(first.pull.ok).toBe(false);
    expect(first.events).toBe(1);
    const p = join(h, 'flows/local-pulse/drafts/lp-20261112-email.json');
    writeFileSync(
      p,
      JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), body: 'mine', edited_at: 'x' }),
    );
    await runRoundup({ repoRoot: REPO_ROOT, fwHome: h, env: {}, now: NOW });
    expect(JSON.parse(readFileSync(p, 'utf8')).body).toBe('mine');
  });
});
