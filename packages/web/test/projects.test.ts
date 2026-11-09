// Projects screen grouping: brands merge across case and spacing, unlabelled projects come last.
import { expect, test } from 'vitest';
import type { Project } from '../src/api/types';
import { groupProjects } from '../src/projects/ProjectsPage';

const p = (id: string, brand: string | null, category: string | null): Project => ({
  id,
  name: id,
  repo: null,
  status: 'active',
  brand,
  category,
});

const ALL = [
  p('a', 'Frequency', 'marketing'),
  p('b', null, 'product'),
  p('c', 'frequency ', 'product'),
  p('d', 'Atlas', null),
];

test('groups by brand, merging case and spacing, unlabelled last', () => {
  expect(groupProjects(ALL, 'brand').map(([k, ps]) => [k, ps.map((x) => x.id)])).toEqual([
    ['Atlas', ['d']],
    ['Frequency', ['a', 'c']],
    ['No brand', ['b']],
  ]);
});

test('groups by category with readable names', () => {
  expect(groupProjects(ALL, 'category').map(([k, ps]) => [k, ps.map((x) => x.id)])).toEqual([
    ['Marketing', ['a']],
    ['Product', ['b', 'c']],
    ['No category', ['d']],
  ]);
});
