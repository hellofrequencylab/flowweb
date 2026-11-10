import { describe, expect, it } from 'vitest';
import type { FlowDraft } from '../src/api/types';
import { groupDrafts, hasBlankSlot, outcomeOf } from '../src/flows/drafts';

const d = (id: string, over: Partial<FlowDraft> = {}): FlowDraft => ({
  id,
  fire_id: null,
  lead_id: null,
  channel: null,
  subject: `Subject ${id}`,
  body: 'Hi there',
  status: 'waiting_for_owner',
  created_at: '2026-11-10T04:00:00Z',
  ...over,
});

describe('drafts sorting', () => {
  it('puts real drafts first, unfilled templates next, handled ones last', () => {
    const g = groupDrafts([
      d('t1', { subject: 'A Circle at {{venue_name}}?' }),
      d('r1', { created_at: '2026-11-10T03:00:00Z' }),
      d('x1', { status: 'rejected', rejected_at: '2026-11-10T05:00:00Z' }),
      d('t2', { body: 'Hello {{ sub_area_name }}' }),
      d('r2', { created_at: '2026-11-10T05:00:00Z' }),
    ]);
    expect(g.ready.map((x) => x.id)).toEqual(['r2', 'r1']);
    expect(g.templates.map((x) => x.id).sort()).toEqual(['t1', 't2']);
    expect(g.done.map((x) => x.id)).toEqual(['x1']);
  });

  it('moves drafts you sent into their own group, newest send first, and names the outcome', () => {
    const g = groupDrafts([
      d('s1', { sent_at: '2026-11-10T01:00:00Z' }),
      d('s2', { sent_at: '2026-11-10T02:00:00Z', replied_at: '2026-11-10T03:00:00Z' }),
      d('x', { status: 'rejected', sent_at: '2026-11-10T02:00:00Z' }),
      d('r'),
    ]);
    expect(g.sent.map((x) => x.id)).toEqual(['s2', 's1']);
    expect(g.ready.map((x) => x.id)).toEqual(['r']);
    expect(g.done.map((x) => x.id)).toEqual(['x']);
    expect(outcomeOf(g.sent[0] as FlowDraft)).toBe('replied');
    expect(outcomeOf(d('n', { sent_at: 'a', declined_at: 'b' }))).toBe('declined');
    expect(outcomeOf(d('o'))).toBeNull();
  });

  it('only treats {{name}} slots as blanks', () => {
    expect(hasBlankSlot(d('a', { body: 'Join us {at} 6' }))).toBe(false);
    expect(hasBlankSlot(d('b', { subject: null, body: '{{first_name}}, hi' }))).toBe(true);
  });
});
