// FW-C-041: the pure rules that decide who a hunt writes to.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  composeBody,
  dueHunts,
  type Hunt,
  newHunt,
  onDoNotContact,
  parseLeads,
  screenLeads,
} from '../src/flows/hunts.ts';
import { type FlowConfig, initialState } from '../src/flows/neighborhood-activation.ts';
import { addDoNotContact } from '../src/flows/neighborhood-admin.ts';

const cfg = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../flows/neighborhood-activation/config.json'), 'utf8'),
) as FlowConfig;
const now = new Date('2026-11-10T08:00:00Z');
const hunt = (o: Partial<Hunt> = {}): Hunt => ({
  ...newHunt(cfg, { name: 'Sound baths', looking_for: 'sound baths', region: 'north-county-sd' }, now),
  ...o,
});
const lead = (h: Hunt, email: string, source = 'https://example.com/o') =>
  parseLeads({
    leads: [
      {
        hunt_id: h.id,
        event: { title: 'Bath', url: 'https://example.com/e' },
        organizer: { email, source_url: source },
        body: 'Hi!',
      },
    ],
  })[0]!;

describe('hunts', () => {
  test('a hunt is due by every_days, or when asked for by hand', () => {
    const fresh = hunt({ last_run_at: '2026-11-10T07:00:00Z' });
    const old = hunt({ last_run_at: '2026-11-08T07:00:00Z' });
    const off = hunt({ enabled: false, last_run_at: null });
    const asked = hunt({ enabled: false, last_run_at: now.toISOString(), requested_at: now.toISOString() });
    expect(dueHunts([fresh, old, off, asked], now).map((h) => h.id)).toEqual([old.id, asked.id]);
  });

  test('do-not-contact matches the address, its @domain, mailto and the pages', () => {
    expect(onDoNotContact(['a@x.org'], 'A@x.org'.toLowerCase(), [])).toBe(true);
    expect(onDoNotContact(['@x.org'], 'b@x.org', [])).toBe(true);
    expect(onDoNotContact(['https://example.com/o'], 'c@y.org', ['https://example.com/o'])).toBe(true);
    expect(onDoNotContact(['@x.org'], 'c@y.org', ['https://example.com/o'])).toBe(false);
  });

  test('the flow weekly cap holds leads even under the hunt cap', () => {
    const h = hunt({ max_sends: 25 });
    const state = initialState(now);
    const tight = { ...cfg, leads: { ...cfg.leads, max_new_invites_per_week: 1 } };
    const leads = [lead(h, 'one@example.com'), lead(h, 'two@example.com')];
    const { kept, counts } = screenLeads({ cfg: tight, state, hunts: [h], leads, now });
    expect(kept).toHaveLength(1);
    expect(counts[h.id]).toMatchObject({ drafted: 1, capped: 1 });
  });

  test('a lead for a hunt that is not due is ignored, and a guessed address is not public', () => {
    const h = hunt();
    const other = hunt();
    const { counts } = screenLeads({
      cfg,
      state: initialState(now),
      hunts: [h],
      leads: [
        lead(other, 'x@example.com'),
        lead(h, 'not-an-address'),
        lead(h, 'y@example.com', 'file:///etc'),
      ],
      now,
    });
    expect(counts[h.id]).toMatchObject({ found: 2, not_public: 2, drafted: 0 });
  });

  test('fwd adds the link or claim slot, the sign-off, the source page and the opt-out', () => {
    const plain = composeBody(cfg, hunt(), lead(hunt(), 'a@example.com'));
    expect(plain).toMatch(/\/start\/host\?persona=practitioner&region=north-county-sd&src=hunt/);
    expect(plain).toMatch(/https:\/\/example\.com\/o/);
    expect(plain).toMatch(/Reply "no"/);
    expect(composeBody(cfg, hunt({ build: true }), lead(hunt(), 'a@example.com'))).toContain('{{claim_url}}');
  });

  test('a saved hunt refuses bad areas and links', () => {
    expect(() =>
      newHunt(cfg, { name: 'x', looking_for: 'y', region: 'north-county-sd', areas: ['irvine'] }, now),
    ).toThrow(/sub-areas/);
    expect(() =>
      newHunt(cfg, { name: 'x', looking_for: 'y', region: 'north-county-sd', links: ['ftp://a'] }, now),
    ).toThrow(/links/);
  });

  test('do-not-contact takes an address or an @domain', () => {
    const s = initialState(now);
    expect(addDoNotContact(s, { email: '@spam.org', reason: 'asked' }).state?.do_not_contact).toEqual([
      '@spam.org',
    ]);
    expect(() => addDoNotContact(s, { email: 'nope', reason: 'asked' })).toThrow(/address/);
  });
});
