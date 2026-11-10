import { describe, expect, it } from 'vitest';
import type { FlowDraft } from '../src/api/types';
import { ageOf, draftsPerDay, inboxOrder, recipientOf, stateOf } from '../src/flows/drafts';

const d = (over: Partial<FlowDraft>): FlowDraft => ({
  id: 'd',
  fire_id: null,
  lead_id: null,
  channel: null,
  subject: 'Hello',
  body: 'Hi Front Porch Gallery team,\n\nA note.',
  status: 'waiting_for_owner',
  created_at: '2026-11-10T10:00:00Z',
  ...over,
});

describe('draft helpers for the inbox', () => {
  it('names one state per draft', () => {
    expect(stateOf(d({}))).toBe('Ready');
    expect(stateOf(d({ body: 'Hi {{venue_name}},' }))).toBe('Has blanks');
    expect(stateOf(d({ sent_at: 'x' }))).toBe('Sent');
    expect(stateOf(d({ sent_at: 'x', replied_at: 'y' }))).toBe('Replied');
    expect(stateOf(d({ sent_at: 'x', declined_at: 'y' }))).toBe('Said no');
    expect(stateOf(d({ status: 'approved' }))).toBe('Approved');
    expect(stateOf(d({ status: 'rejected', sent_at: 'x' }))).toBe('Rejected');
  });

  it('orders ready drafts first, newest first', () => {
    const ids = inboxOrder([
      d({ id: 'sent', sent_at: '2026-11-09T00:00:00Z' }),
      d({ id: 'old', created_at: '2026-11-01T00:00:00Z' }),
      d({ id: 'new', created_at: '2026-11-09T00:00:00Z' }),
      d({ id: 'tpl', body: 'Hi {{x}},' }),
    ]).map((x) => x.id);
    expect(ids).toEqual(['new', 'old', 'tpl', 'sent']);
  });

  it('reads who a draft is for from its greeting', () => {
    expect(recipientOf(d({}))).toBe('Front Porch Gallery team');
    expect(recipientOf(d({ body: 'Hi {{venue_name}}, hello' }))).toBeNull();
    expect(recipientOf(d({ body: 'No greeting here.' }))).toBeNull();
  });

  it('gives short ages and per-day counts', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(ageOf('2026-11-10T11:55:00Z', now)).toBe('5m');
    expect(ageOf('2026-11-08T12:00:00Z', now)).toBe('2d');
    expect(ageOf(null, now)).toBe('');
    const days = draftsPerDay([d({}), d({}), d({ created_at: '2026-11-09T10:00:00Z' })], 3, now);
    expect(days).toEqual([0, 1, 2]);
  });
});
