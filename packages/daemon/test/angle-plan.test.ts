import { describe, expect, it } from 'vitest';
import { anglePlan, anglePlanRule } from '../src/flows/angle-plan.ts';

const niches = [
  { key: 'sound', angles: [{ key: 'fill_room' }, { key: 'fees' }, { key: 'scattered' }] },
  { key: 'solo', angles: [{ key: 'only' }] },
];
const sent = (angle: string, n: number, replied: number) =>
  Array.from({ length: n }, (_, i) => ({
    niche: 'sound',
    angle,
    sent_at: '2026-11-02T00:00:00.000Z',
    ...(i < replied ? { replied_at: '2026-11-03T00:00:00.000Z' } : {}),
  }));

describe('anglePlan (FW-C-168)', () => {
  it('names the first two angles when nothing was sent, and skips a niche with one angle', () => {
    expect(anglePlan(niches, [])).toEqual([{ niche: 'sound', angles: ['fill_room', 'fees'], proven: null }]);
  });
  it('keeps to the two least-tried angles until one has 8 sends', () => {
    const plan = anglePlan(niches, [...sent('fill_room', 7, 7), ...sent('fees', 2, 0)]);
    expect(plan[0]).toEqual({ niche: 'sound', angles: ['scattered', 'fees'], proven: null });
  });
  it('prefers the proven angle and pairs it with the least-tried other one', () => {
    const drafts = [...sent('fill_room', 8, 1), ...sent('fees', 9, 5), ...sent('scattered', 2, 2)];
    expect(anglePlan(niches, drafts)[0]).toEqual({
      niche: 'sound',
      angles: ['fees', 'scattered'],
      proven: 'fees',
    });
  });
  it('does not count a draft that was never sent', () => {
    const waiting = Array.from({ length: 9 }, () => ({ niche: 'sound', angle: 'fees', status: 'rejected' }));
    expect(anglePlan(niches, waiting)[0]?.proven).toBeNull();
  });
  it('adds one brief line only when there is a plan', () => {
    expect(anglePlanRule(0)).toEqual([]);
    expect(anglePlanRule(3)).toHaveLength(1);
  });
});
