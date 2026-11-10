import { describe, expect, it } from 'vitest';
import type { Hunt } from '../src/flows/hunts.ts';
import { type HuntCard, proposeShifts } from '../src/flows/review.ts';

const hunt = (id: string, max_sends: number): Hunt =>
  ({ id, name: id, max_sends, enabled: true }) as unknown as Hunt;
const card = (hunt_id: string, sent: number, responded: number): HuntCard => ({
  hunt_id,
  name: hunt_id,
  drafted: sent,
  sent,
  replied: responded,
  declined: 0,
  leads: 0,
  members: 0,
  hosts: 0,
  paid: 0,
  responded,
  rate: sent ? responded / sent : null,
});

describe('proposeShifts (FW-C-056)', () => {
  it('pauses a hunt with 15 sent and nothing back', () => {
    const { shifts } = proposeShifts(
      [hunt('a', 10), hunt('b', 10)],
      [card('a', 12, 6), card('b', 15, 0)],
      't',
    );
    expect(shifts.find((s) => s.hunt_id === 'b')?.kind).toBe('pause');
  });
  it('moves sends toward the hunt that responds without raising the total', () => {
    const hunts = [hunt('a', 10), hunt('b', 10), hunt('c', 10)];
    const { shifts } = proposeShifts(hunts, [card('a', 20, 10), card('b', 20, 1), card('c', 10, 2)], 't');
    const moves = shifts.filter((s) => s.kind === 'max_sends');
    const delta = moves.reduce((n, s) => n + (s.to as number) - (s.from as number), 0);
    expect(delta).toBeLessThanOrEqual(0);
    expect(moves.find((s) => s.hunt_id === 'a')?.to as number).toBeGreaterThan(10);
    expect(moves.find((s) => s.hunt_id === 'b')?.to as number).toBeLessThan(10);
  });
  it('leaves hunts alone with too few sends to judge', () => {
    expect(
      proposeShifts([hunt('a', 10), hunt('b', 10)], [card('a', 3, 3), card('b', 3, 0)], 't').shifts,
    ).toEqual([]);
  });
});
