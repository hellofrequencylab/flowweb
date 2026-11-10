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
  restrictedLead,
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
    expect(plain).toMatch(/reply "no"/);
    // FW-C-089: the Owner's own sign-off, then a P.S. with where he is, the source page and the opt-out.
    expect(plain).toContain(
      "\n\nDaniel Tyack\nFounder\nfrequencylocal.com\n\nP.S. I'm local to San Diego (North County) and found your address on https://example.com/o",
    );
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

test('the sign-off is plain text with no em dash, in the Owner name', () => {
  const body = composeBody(cfg, hunt({ build: false }), {
    hunt_id: 'h',
    event: { title: 'T', starts_at: null, url: 'https://e.example/x', country: null },
    organizer: {
      name: null,
      email: 'a@example.com',
      source_url: 'https://e.example/x',
      country: null,
      contact_via: 'email',
      contact_url: null,
    },
    subject: null,
    body: 'Hi.',
  });
  expect(body.includes('\u2014')).toBe(false);
  expect(body).toMatch(/\nDaniel Tyack\n/);
});

// FW-C-052: where a hunt may write, and how each draft is sent.
const reach = (h: Hunt, organizer: Record<string, unknown>, event: Record<string, unknown> = {}) =>
  parseLeads({
    leads: [
      {
        hunt_id: h.id,
        event: { title: 'Bath', url: 'https://example.com/e', ...event },
        organizer: { source_url: 'https://example.com/o', ...organizer },
        body: 'Hi!',
      },
    ],
  })[0]!;

test('EU, EEA, UK and Canadian leads are restricted, by country or by domain', () => {
  const h = hunt();
  expect(restrictedLead(reach(h, { email: 'a@example.com', country: 'us' }))).toBe(false);
  expect(restrictedLead(reach(h, { email: 'a@example.com', country: 'de' }))).toBe(true);
  expect(restrictedLead(reach(h, { email: 'a@example.com' }, { country: 'CA' }))).toBe(true);
  expect(restrictedLead(reach(h, { email: 'a@example.com', country: 'NO' }))).toBe(true);
  expect(restrictedLead(reach(h, { email: 'a@shop.co.uk' }))).toBe(true);
  expect(restrictedLead(reach(h, { email: 'a@example.eu' }))).toBe(true);
  expect(
    restrictedLead(reach(h, { email: 'a@example.com', source_url: 'https://events.example.ie/x' })),
  ).toBe(true);
  expect(restrictedLead(reach(h, { email: 'a@example.io' }))).toBe(false);
});

test('a form or profile lead is drafted without an address and says how to send it', () => {
  const h = hunt();
  const state = initialState(now);
  const leads = [
    reach(h, { email: 'a@example.com' }),
    reach(h, { contact_via: 'form', contact_url: 'https://example.com/contact' }),
    reach(h, { contact_via: 'platform', contact_url: 'https://www.meetup.com/g/x' }),
    reach(h, { contact_via: 'social', contact_url: 'http://insecure.example.com/p' }),
    reach(h, { contact_via: 'form', contact_url: 'https://example.com/contact' }),
    reach(h, { email: 'b@example.com', country: 'FR' }),
  ];
  const { kept, counts } = screenLeads({ cfg, state, hunts: [h], leads, now });
  expect(kept.map((k) => k.send_via)).toEqual(['email', 'contact_form', 'platform_message']);
  expect(kept[0]!.send_how).toContain('a@example.com');
  expect(kept[1]!.send_how).toContain('https://example.com/contact');
  expect(kept[1]!.body).toMatch(/how to reach you on https:\/\/example\.com\/o\..*reply "no"/i);
  expect(counts[h.id]).toMatchObject({ drafted: 3, not_public: 1, duplicate: 1, restricted: 1 });
});
