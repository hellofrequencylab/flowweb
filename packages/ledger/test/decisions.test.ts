// WS-P1-024: decision items on a temp store with a fake clock.
import { describe, expect, test } from 'vitest';
import { createDecisionItem, expireDecisionItems, LedgerError, listDecisionItems } from '../src/index.ts';
import { fileStore, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();
const store = fileStore(dir, 'decisions.sqlite');
syncInto(store, writeRows(`${dir}/rows`, [row('FW-C-941')]));
const w = store.writer!;
let t = Date.parse('2026-11-10T09:00:00.000Z');
const opts = { now: () => new Date(t) };
const choose = {
  variant: 'choose' as const,
  ask: 'Pick the queue order for this week.',
  options: [
    { id: 'oldest', label: 'Oldest first', consequence: 'Stale rows close first.' },
    { id: 'smallest', label: 'Smallest first', consequence: 'More rows close sooner.' },
  ],
  recommended: 'smallest',
  recommendation_reason: 'Small rows unblock the most dependants.',
  default_on_timeout: 'smallest',
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return (e as LedgerError).code;
  }
  throw new Error('expected a refusal');
}

describe('decision items', () => {
  test('refuses a recommendation outside the options, a past deadline, and an unknown status filter', () => {
    expect(code(() => createDecisionItem(w, { ...choose, recommended: 'z' }, opts))).toBe('BAD_ARGUMENT');
    expect(code(() => createDecisionItem(w, { ...choose, deadline: '2026-11-10T08:00:00Z' }, opts))).toBe(
      'BAD_ARGUMENT',
    );
    expect(code(() => createDecisionItem(w, { ...choose, deadline: 'tomorrow' }, opts))).toBe('BAD_ARGUMENT');
    expect(code(() => createDecisionItem(w, { ...choose, project: 'no-such-project' }, opts))).toBe(
      'NOT_FOUND',
    );
    expect(code(() => createDecisionItem(w, { ...choose, options: [choose.options[1]!] }, opts))).toBe(
      'INVALID_DEFINITION',
    );
    expect(code(() => listDecisionItems(w, { status: 'closed' as never }))).toBe('BAD_ARGUMENT');
    expect(listDecisionItems(w)).toEqual([]);
  });

  test('expires snoozed items too, at the deadline and not before', () => {
    const item = createDecisionItem(w, { ...choose, deadline: new Date(t + 60_000) }, opts);
    expect(item).toMatchObject({ status: 'open', title: choose.ask, urgency: 'today', stream_id: null });
    expect((item.body as { recommended_option?: string }).recommended_option).toBe('smallest');
    w.run("UPDATE decision_cards SET status = 'snoozed' WHERE id = ?", [item.card_id]);
    t += 59_999;
    expect(expireDecisionItems(w, opts)).toEqual([]);
    t += 1;
    expect(expireDecisionItems(w, opts)).toEqual([
      { card_id: item.card_id, variant: 'choose', default_applied: 'smallest', approval_id: null },
    ]);
    const [after] = listDecisionItems(w, { status: 'expired' });
    expect(after).toMatchObject({ card_id: item.card_id, default_applied: 'smallest' });
  });
});
