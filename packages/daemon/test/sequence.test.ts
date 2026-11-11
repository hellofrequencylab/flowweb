// FW-C-104: the outreach sequence. Three touches at about day 0, 5 and 12; a reply or a no ends it the
// same day; a DM lead with a public email is offered email next.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { dueTouches, loadSequence } from '../src/flows/sequence.ts';
import { tempHome } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const NOW = new Date('2026-11-20T17:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const h = tempHome();
  cleanups.push(h.cleanup);
  const dir = join(h.path, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const put = (id: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        flow: KEY,
        id,
        channel: 'frequency',
        send_via: 'email',
        to: `${id}@example.com`,
        status: 'waiting_for_owner',
        created_at: ago(30),
        ...extra,
      }),
    );
  return { home: h.path, put };
}

test('touch 2 is due about day 5, a reply closes the lead, and a fourth touch is never due', () => {
  const t = setup();
  t.put('a1', { send_via: 'social_dm', to: null, sent_at: ago(5.1) });
  t.put('b1', { sent_at: ago(5.1), replied_at: ago(0.1) });
  t.put('e1', { sent_at: ago(2) });
  for (const [i, d] of [20, 15, 8].entries())
    t.put(`c${i + 1}`, { sequence_lead: 'lead-c', sent_at: ago(d), created_at: ago(d) });
  const due = dueTouches(KEY, NOW, t.home);
  expect(due.map((d) => [d.lead, d.n, d.route])).toEqual([['a1', 2, 'social_dm']]);
  const leads = loadSequence(t.home, KEY).leads;
  expect(leads['b1@example.com']).toMatchObject({ state: 'closed', closed_reason: 'replied' });
  expect(leads['lead-c']).toMatchObject({ state: 'closed', closed_reason: 'three_touches' });
  expect(leads['lead-c']?.touches).toHaveLength(3);
  expect(leads['e1@example.com']).toMatchObject({ state: 'touch1' });
  // Day 12: touch 3 comes due, and after it nothing more.
  t.put('d1', { sequence_lead: 'lead-d', sent_at: ago(12.5), created_at: ago(13) });
  t.put('d2', { sequence_lead: 'lead-d', sent_at: ago(7.4), created_at: ago(8) });
  expect(dueTouches(KEY, NOW, t.home).find((d) => d.lead === 'lead-d')?.n).toBe(3);
  t.put('d3', { sequence_lead: 'lead-d', sent_at: ago(0.1), created_at: ago(0.2) });
  t.put('d4', { sequence_lead: 'lead-d', sent_at: ago(0.05), created_at: ago(0.1) });
  expect(
    dueTouches(KEY, new Date(NOW.getTime() + 60 * 86_400_000), t.home).some((d) => d.lead === 'lead-d'),
  ).toBe(false);
  expect(loadSequence(t.home, KEY).leads['lead-d']?.touches).toHaveLength(3);
});

test('a declined lead and a lead on do-not-contact close the same day', () => {
  const t = setup();
  t.put('x1', { sent_at: ago(6), declined_at: NOW.toISOString() });
  t.put('y1', { sent_at: ago(6) });
  writeFileSync(
    join(t.home, 'flows', KEY, 'state.json'),
    JSON.stringify({ do_not_contact: ['y1@example.com'] }),
  );
  expect(dueTouches(KEY, NOW, t.home)).toEqual([]);
  const leads = loadSequence(t.home, KEY).leads;
  expect(leads['x1@example.com']).toMatchObject({ closed_reason: 'declined', closed_at: NOW.toISOString() });
  expect(leads['y1@example.com']?.closed_reason).toBe('do_not_contact');
});

test('a DM lead with a public email is offered touch 2 by email', () => {
  const t = setup();
  t.put('a1', {
    send_via: 'social_dm',
    to: null,
    public_email: 'host@example.com',
    sequence_lead: 'lead-a',
    sent_at: ago(5.2),
  });
  t.put('b1', { send_via: 'social_dm', to: null, sequence_lead: 'lead-b', sent_at: ago(5.2) });
  expect(dueTouches(KEY, NOW, t.home).map((d) => [d.lead, d.route, d.previous_route])).toEqual([
    ['lead-a', 'email', 'social_dm'],
    ['lead-b', 'social_dm', 'social_dm'],
  ]);
});
