// node --test hosted/test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterList, mirrorKey, resolveRead, routeOfUrl, sumSpend } from '../server/mirror.mjs';

const env = (data, as_of = '2026-11-09T10:00:00.000Z') => ({ data, as_of, head_seq: 7, next_cursor: null });

function store(entries) {
  const m = new Map(Object.entries(entries));
  return {
    lookup: async (keys) => new Map(keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)])),
    lookupPrefix: async (p) => [...m].filter(([k]) => k.startsWith(p)).sort(),
  };
}

test('keys sort the query and drop empty values', () => {
  assert.equal(mirrorKey('/runs', 'status=&b=2&a=1'), '/runs?a=1&b=2');
  assert.equal(mirrorKey('/status', ''), '/status');
});

test('list routes filter the full copy and keep fwd as_of', () => {
  const rows = env([
    { id: 'lr_A', code: 'FW-C-001', title: 'Contracts', status: 'done' },
    { id: 'lr_B', code: 'FW-C-002', title: 'Event log', status: 'open' },
  ]);
  const out = filterList('/ledger/rows', rows, new URLSearchParams('status=open&limit=200'));
  assert.deepEqual(
    out.data.map((r) => r.id),
    ['lr_B'],
  );
  assert.equal(out.as_of, rows.as_of);
  const q = filterList('/ledger/rows', rows, new URLSearchParams('q=contract'));
  assert.deepEqual(
    q.data.map((r) => r.id),
    ['lr_A'],
  );
});

test('projects filter by brand (any case) and category', () => {
  const projects = {
    as_of: '2026-11-09T10:00:00.000Z',
    data: [
      { id: 'prj_a', brand: 'Frequency', category: 'marketing' },
      { id: 'prj_b', brand: 'Frequency', category: 'product' },
      { id: 'prj_c', brand: null, category: null },
    ],
  };
  const ids = (q) => filterList('/projects', projects, new URLSearchParams(q)).data.map((p) => p.id);
  assert.deepEqual(ids('brand=frequency'), ['prj_a', 'prj_b']);
  assert.deepEqual(ids('brand=Frequency&category=product'), ['prj_b']);
  assert.deepEqual(ids('category=Product'), []);
  assert.deepEqual(ids(''), ['prj_a', 'prj_b', 'prj_c']);
});

test('events honour after_seq and limit', () => {
  const ev = env([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  const out = filterList('/events', ev, new URLSearchParams('after_seq=1&limit=1'));
  assert.deepEqual(out.data, [{ seq: 2 }]);
});

test('spend sums the days inside the window and reports the oldest as_of', () => {
  const days = [
    ['2026-11-07', env({ total_usd: 1, groups: [{ key: 'p1', usd: 1 }] }, '2026-11-09T10:00:00.000Z')],
    ['2026-11-08', env({ total_usd: 2, groups: [{ key: 'p1', usd: 2 }] }, '2026-11-09T09:00:00.000Z')],
    ['2026-11-09', env({ total_usd: 4, groups: [{ key: 'p2', usd: 4 }] }, '2026-11-09T11:00:00.000Z')],
  ];
  const out = sumSpend(
    days,
    new URLSearchParams('group_by=project&from=2026-11-08T00:00:00.000Z&to=2026-11-09T12:00:00.000Z'),
  );
  assert.equal(out.data.total_usd, 6);
  assert.equal(out.as_of, '2026-11-09T09:00:00.000Z');
  assert.equal(out.data.granularity, 'day');
});

test('nothing synced is 503 not_synced; a missing record after a sync is 404', async () => {
  const empty = await resolveRead('/runs/run_x', new URLSearchParams(), store({}));
  assert.equal(empty.status, 503);
  assert.equal(empty.body.error.code, 'not_synced');
  const some = await resolveRead('/runs/run_x', new URLSearchParams(), store({ '/status': env({}) }));
  assert.equal(some.status, 404);
});

test('detail routes are served exactly as copied', async () => {
  const s = store({ '/runs/run_1': env({ id: 'run_1' }) });
  const r = await resolveRead('/runs/run_1', new URLSearchParams(), s);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.id, 'run_1');
});

test('the rewrite copy of the path is not part of the query', () => {
  const r = routeOfUrl('https://x.test/api/v1?__p=policy&path=policy');
  assert.equal(r.path, '/policy');
  assert.equal(mirrorKey(r.path, r.params), '/policy');
  const d = routeOfUrl('https://x.test/api/v1?__p=runs%2Frun_1&path=runs%2Frun_1');
  assert.equal(mirrorKey(d.path, d.params), '/runs/run_1');
  const q = routeOfUrl('https://x.test/api/v1?__p=runs&path=runs&status=open');
  assert.equal(mirrorKey(q.path, q.params), '/runs?status=open');
  // A real filter that happens to equal the path is kept.
  const same = routeOfUrl('https://x.test/api/v1?__p=runs&path=runs&status=runs');
  assert.equal(mirrorKey(same.path, same.params), '/runs?status=runs');
});
