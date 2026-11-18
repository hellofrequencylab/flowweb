// FW-C-154: a draft never points at an event that has passed.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { eventPassed, retirePastDrafts, staleReason } from '../src/flows/past-events.ts';

const NOW = new Date('2026-11-18T19:00:00.000Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

test('an event counts as passed a day after it starts; an unreadable date does not', () => {
  expect(eventPassed(ago(2), NOW)).toBe(true);
  expect(eventPassed(ago(0.5), NOW)).toBe(false);
  expect(eventPassed(ago(-3), NOW)).toBe(false);
  expect(eventPassed('2026-11-10', NOW)).toBe(true);
  expect(eventPassed('2026-11-18', NOW)).toBe(false);
  expect(eventPassed('next Tuesday', NOW)).toBe(false);
  expect(eventPassed(null, NOW)).toBe(false);
});

const draft = (extra: Record<string, unknown>) => ({
  id: 'x',
  hunt_id: 'hnt_1',
  status: 'waiting_for_owner',
  created_at: ago(1),
  ...extra,
});

test('only waiting, unsent hunt drafts go stale', () => {
  expect(staleReason(draft({ event: { starts_at: ago(3) } }), NOW)).toBe('event_passed');
  expect(staleReason(draft({ event: { starts_at: ago(-3) } }), NOW)).toBe(null);
  expect(staleReason(draft({ event: { starts_at: null }, created_at: ago(8) }), NOW)).toBe('no_event_date');
  expect(staleReason(draft({ event: { starts_at: null }, created_at: ago(2) }), NOW)).toBe(null);
  expect(staleReason(draft({ event: { starts_at: ago(3) }, sent_at: ago(2) }), NOW)).toBe(null);
  expect(staleReason(draft({ event: { starts_at: ago(3) }, status: 'handed_off' }), NOW)).toBe(null);
  expect(staleReason({ id: 't', lead_id: 'template:host', status: 'waiting_for_owner' }, NOW)).toBe(null);
});

test('retiring keeps the draft on disk, says why, and frees the contact for a later hunt', () => {
  const home = mkdtempSync(join(tmpdir(), 'past-events-'));
  const base = join(home, 'flows', 'f');
  mkdirSync(join(base, 'drafts'), { recursive: true });
  const put = (id: string, extra: Record<string, unknown>) =>
    writeFileSync(join(base, 'drafts', `${id}.json`), JSON.stringify(draft({ id, ...extra })));
  put('past', { to: 'Old@Example.com', event: { starts_at: ago(4) } });
  put('form', { contact_url: 'https://example.com/contact', event: { starts_at: ago(9) } });
  put('soon', { to: 'new@example.com', event: { starts_at: ago(-2) } });
  writeFileSync(
    join(base, 'state.json'),
    JSON.stringify({
      do_not_contact: ['x@example.com'],
      hunt_contacts: {
        'old@example.com': { at: ago(5) },
        'https://example.com/contact': { at: ago(10) },
        'new@example.com': { at: ago(1) },
      },
    }),
  );
  expect(retirePastDrafts({ home, flow: 'f', now: NOW }).sort()).toEqual(['form', 'past']);
  const read = (id: string) => JSON.parse(readFileSync(join(base, 'drafts', `${id}.json`), 'utf8'));
  expect([read('past').status, read('past').retired]).toEqual(['rejected', 'event_passed']);
  expect(read('past').held).toMatch(/^event_passed: /);
  expect(read('soon').status).toBe('waiting_for_owner');
  const state = JSON.parse(readFileSync(join(base, 'state.json'), 'utf8'));
  expect(Object.keys(state.hunt_contacts)).toEqual(['new@example.com']);
  expect(state.do_not_contact).toEqual(['x@example.com']);
  expect(retirePastDrafts({ home, flow: 'f', now: NOW })).toEqual([]);
});
