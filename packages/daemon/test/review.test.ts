import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Hunt, saveHunts } from '../src/flows/hunts.ts';
import { type HuntCard, proposeShifts, reviewDue } from '../src/flows/review.ts';
import { liveCopies } from '../src/overseer/copies.ts';

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

describe('reviewDue (FW-C-159)', () => {
  const WEEK = 7 * 86_400_000;
  const now = new Date('2026-11-18T20:00:00.000Z');
  const home = () => mkdtempSync(join(tmpdir(), 'fw-review-'));
  const write = (h: string, at: unknown) => {
    mkdirSync(join(h, 'flows', 'neighborhood-activation'), { recursive: true });
    writeFileSync(join(h, 'flows', 'neighborhood-activation', 'review.json'), JSON.stringify({ at }));
  };
  it('is never due for a flow with no hunts', () => {
    expect(reviewDue(home(), WEEK, now)).toBe(false);
  });
  it('is due when there are hunts and no review, or one with no readable date', () => {
    const h = home();
    saveHunts(h, [hunt('a', 10)]);
    expect(reviewDue(h, WEEK, now)).toBe(true);
    write(h, 'not a date');
    expect(reviewDue(h, WEEK, now)).toBe(true);
  });
  it('is due at about a week old and not before', () => {
    const h = home();
    saveHunts(h, [hunt('a', 10)]);
    write(h, new Date(now.getTime() - 86_400_000).toISOString());
    expect(reviewDue(h, WEEK, now)).toBe(false);
    write(h, new Date(now.getTime() - 8 * 86_400_000).toISOString());
    expect(reviewDue(h, WEEK, now)).toBe(true);
  });
});

describe('liveCopies (FW-C-166)', () => {
  it('lists the copies of a base flow that are not archived', () => {
    const flows = {
      'neighborhood-activation': {},
      'neighborhood-activation--b': { copy_of: 'neighborhood-activation' },
      'neighborhood-activation--a': { copy_of: 'neighborhood-activation' },
      'neighborhood-activation--old': { copy_of: 'neighborhood-activation', archived: true },
      'local-pulse--x': { copy_of: 'local-pulse' },
    };
    expect(liveCopies(flows, 'neighborhood-activation')).toEqual([
      'neighborhood-activation--a',
      'neighborhood-activation--b',
    ]);
  });
});
