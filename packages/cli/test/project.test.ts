// fw project list / fw project label against a fake CoreClient.
import { expect, test } from 'vitest';
import type { CoreClient, ProjectView } from '../src/client.ts';
import { EXIT, main } from '../src/index.ts';

const p = (slug: string, brand: string | null, category: string | null): ProjectView => ({
  id: `prj_${slug}`,
  slug,
  name: slug,
  kind: 'repo',
  status: 'active',
  repo_url: null,
  created_at: '2026-11-09T00:00:00Z',
  brand,
  category,
});
const ALL = [
  p('flowweb', null, 'product'),
  p('local-marketing', 'Frequency', 'marketing'),
  p('site', 'Frequency', 'product'),
];

async function run(argv: string[], client: Partial<CoreClient>) {
  const o: string[] = [];
  const e: string[] = [];
  const io = { out: (t: string) => void o.push(t), err: (t: string) => void e.push(t), env: {}, cwd: '/' };
  const code = await main(argv, io, () => ({ close() {}, ...client }) as CoreClient);
  return { code, out: o.join('\n'), err: e.join('\n') };
}

test('fw project list passes the filters and prints brand and category', async () => {
  const calls: unknown[] = [];
  const r = await run(['project', 'list', '--brand', 'Frequency', '--category', 'marketing'], {
    projectList: async (f) => {
      calls.push(f);
      return [ALL[1]!];
    },
  });
  expect(r.code).toBe(EXIT.OK);
  expect(calls).toEqual([{ brand: 'Frequency', category: 'marketing' }]);
  expect(r.out).toMatch(/BRAND\s+CATEGORY/);
  expect(r.out).toMatch(/local-marketing\s+local-marketing\s+Frequency\s+marketing/);
});

test('--group-by brand puts each brand under a heading, unlabelled last', async () => {
  const r = await run(['project', 'list', '--group-by', 'brand', '--json'], { projectList: async () => ALL });
  const doc = JSON.parse(r.out) as { groups: { key: string; projects: ProjectView[] }[] };
  expect(doc.groups.map((g) => [g.key, g.projects.length])).toEqual([
    ['Frequency', 2],
    ['(no brand)', 1],
  ]);
  const text = await run(['project', 'list', '--group-by', 'category'], { projectList: async () => ALL });
  expect(text.out).toMatch(/^product \(2\)/);
  expect(text.out).toMatch(/marketing \(1\)/);
});

test('a bad --group-by is a usage error naming the choices', async () => {
  const r = await run(['project', 'list', '--group-by', 'colour'], { projectList: async () => ALL });
  expect(r.code).not.toBe(EXIT.OK);
  expect(r.err).toMatch(/brand, category/);
});

test('fw project label sends only the given fields; an empty value clears', async () => {
  const calls: unknown[] = [];
  const r = await run(['project', 'label', 'site', '--brand', 'Frequency', '--category', ''], {
    projectLabel: async (ref, change) => {
      calls.push([ref, change]);
      return { project: p('site', 'Frequency', null), changed_fields: ['category'], event_seq: 9 };
    },
  });
  expect(r.code).toBe(EXIT.OK);
  expect(calls).toEqual([['site', { brand: 'Frequency', category: '' }]]);
  expect(r.out).toBe('site: brand Frequency, category none (event #9)');
});

test('fw project label with no option shows the current labels and changes nothing', async () => {
  const calls: unknown[] = [];
  const r = await run(['project', 'label', 'site'], {
    projectLabel: async (ref, change) => {
      calls.push([ref, change]);
      return { project: p('site', 'Frequency', 'product'), changed_fields: [], event_seq: null };
    },
  });
  expect(r.code).toBe(EXIT.OK);
  expect(calls).toEqual([['site', {}]]);
  expect(r.out).toBe('site: brand Frequency, category product (no change)');
});
