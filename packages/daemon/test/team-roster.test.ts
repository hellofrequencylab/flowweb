// FW-C-123: the agent roster: complete cards, one reporting tree.
import { expect, test } from 'vitest';
import { ROLES } from '../src/team/roles.ts';

test('every card is complete and the reporting lines form one tree', () => {
  const ids = new Set(ROLES.map((r) => r.id));
  for (const r of ROLES) if (r.reports_to) expect(ids.has(r.reports_to)).toBe(true);
  for (const r of ROLES.filter((x) => x.level !== 'building')) {
    for (const f of [
      'archetype',
      'voice',
      'says',
      'cares_about',
      'judged_on',
      'never',
      'escalates',
      'face',
    ] as const)
      expect(r[f], `${r.id}.${f}`).toBeTruthy();
  }
  expect(JSON.stringify(ROLES)).not.toMatch(/[–—]/);
});
