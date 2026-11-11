import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '@fw/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanEvent,
  inArea,
  loadConfig,
  markDropped,
  type PulseConfig,
  readVenues,
  type UpcomingEvent,
} from '../src/flows/local-pulse.ts';

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

describe('local pulse (FW-C-107)', () => {
  it('ships a stream definition valid against the contract', () => {
    const s = JSON.parse(readFileSync(join(REPO_ROOT, 'flows/local-pulse/stream.json'), 'utf8'));
    expect(validate('stream-definition', s).errors).toEqual([]);
  });

  it('keeps only contract fields and drops an event without a link', () => {
    expect(cleanEvent({ ...ev('a', 'Encinitas', 1), email: 'x@example.com' })).not.toHaveProperty('email');
    expect(cleanEvent({ ...ev('a', 'Encinitas', 1), rsvp_url: 'javascript:alert(1)' })).toBeNull();
  });

  it('keeps events in the open sub-areas and the next 14 days, soonest first', () => {
    const got = inArea(
      cfg(),
      [
        ev('c', 'Del Mar', 5),
        ev('a', 'leucadia', 1),
        ev('x', 'Oceanside', 2),
        ev('y', 'Carlsbad', 20),
        ev('z', 'Carlsbad', -1),
      ],
      NOW,
    );
    expect(got.map((e) => e.event_id)).toEqual(['a', 'c']);
  });

  it('marks a poster dropped and reads qr scans from the outcomes pull', () => {
    const h = home();
    expect(readVenues(REPO_ROOT, h)[0]?.scans_7d).toBeNull();
    markDropped(REPO_ROOT, h, 'qr-new', { venue: 'New Cafe', at: '2026-11-12T00:00:00Z' });
    mkdirSync(join(h, 'flows/neighborhood-activation'), { recursive: true });
    writeFileSync(
      join(h, 'flows/neighborhood-activation/outcomes.json'),
      JSON.stringify({ qr: [{ source_tag: 'qr-new', scans_7d: 4 }] }),
    );
    const v = readVenues(REPO_ROOT, h).find((x) => x.source_tag === 'qr-new');
    expect(v).toEqual({
      venue: 'New Cafe',
      source_tag: 'qr-new',
      poster_dropped_at: '2026-11-12T00:00:00Z',
      scans_7d: 4,
    });
    expect(() => markDropped(REPO_ROOT, h, 'qr-unknown', {})).toThrow(/no venue/);
  });
});
