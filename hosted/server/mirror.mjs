// Serves fwd's /v1 read routes from the mirror the relay pushed (hosted/relay/fw-relay.mjs).
//
// Pure functions only, so they can be tested without a database. The envelope's as_of is
// always the time fwd read its own database, never the time the mirror was read, so the UI
// shows true data age.

/**
 * The /v1 path and query of a request rewritten by vercel.json (`/v1/:path*` -> `/api/v1?__p=:path*`).
 * Vercel also copies the named segment into the query (as `path=...`); that copy is not part of
 * the caller's query and must not reach the mirror key, or every detail read misses.
 */
export function routeOfUrl(href) {
  const url = new URL(href);
  const p = url.searchParams.get('__p') ?? '';
  url.searchParams.delete('__p');
  for (const [k, v] of [...url.searchParams]) if (v === p) url.searchParams.delete(k);
  const path = `/${p}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return { path, params: url.searchParams };
}

/** Sorted query string so the relay and the server agree on keys. */
export function mirrorKey(path, params) {
  const p = new URLSearchParams(params);
  const entries = [...p.entries()].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `${path}?${new URLSearchParams(entries).toString()}` : path;
}

/**
 * List routes the relay copies in full (no filters). The server filters them here.
 * `fields` are equality filters the UI sends (`fold` ones ignore case and outer spaces, as fwd
 * does for a project's brand); `q` is a substring search.
 */
export const LISTS = {
  '/ledger/rows': { fields: ['status', 'project_id', 'milestone'], q: ['code', 'title'] },
  '/runs': { fields: ['status', 'row_id', 'project_id'] },
  '/events': { fields: ['type', 'run_id', 'project_id'], afterSeq: true },
  '/decision-cards': { fields: ['status', 'project_id'] },
  '/projects': { fields: ['brand', 'category'], fold: ['brand'] },
  '/budgets': { fields: [] },
  '/status-reports': { fields: ['kind'] },
};

const PAGING = new Set(['limit', 'cursor']);

export function filterList(route, envelope, params) {
  const spec = LISTS[route];
  let data = Array.isArray(envelope.data) ? envelope.data : [];
  for (const f of spec.fields) {
    const want = params.get(f);
    if (want === null || want === '') continue;
    const norm = spec.fold?.includes(f) ? (v) => v.trim().toLowerCase() : (v) => v;
    data = data.filter((x) => norm(String(x?.[f] ?? '')) === norm(want));
  }
  const q = params.get('q');
  if (q && spec.q) {
    const needle = q.toLowerCase();
    data = data.filter((x) => spec.q.some((k) => String(x?.[k] ?? '').toLowerCase().includes(needle)));
  }
  const after = params.get('after_seq');
  if (spec.afterSeq && after) data = data.filter((x) => Number(x?.seq) > Number(after));
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 200);
  return { ...envelope, data: data.slice(0, limit), next_cursor: null };
}

/**
 * /spend is asked for arbitrary [from, to) windows. The relay copies one bucket per UTC day
 * and group; this sums the days that fall inside the window. The answer is day-granular, and
 * says so in `granularity`.
 */
export function sumSpend(dayEnvelopes, params) {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '9999';
  const groups = new Map();
  let total = 0;
  let asOf = null;
  let headSeq = null;
  for (const [day, env] of dayEnvelopes) {
    // A day counts when it starts inside the window (by UTC date for `from`).
    if (day < from.slice(0, 10) || `${day}T00:00:00.000Z` >= to) continue;
    const d = env.data ?? {};
    total += Number(d.total_usd ?? 0);
    for (const g of d.groups ?? []) {
      const prev = groups.get(g.key) ?? { ...g, usd: 0 };
      prev.usd += Number(g.usd ?? 0);
      groups.set(g.key, prev);
    }
    if (!asOf || env.as_of < asOf) asOf = env.as_of;
    headSeq = env.head_seq ?? headSeq;
  }
  return {
    data: {
      group_by: params.get('group_by'),
      from: from || null,
      to: params.get('to'),
      total_usd: Math.round(total * 1e6) / 1e6,
      groups: [...groups.values()],
      granularity: 'day',
    },
    as_of: asOf,
    head_seq: headSeq,
    next_cursor: null,
  };
}

/**
 * Resolve one GET against the mirror.
 * `lookup(keys)` returns a Map of key -> envelope for the keys that exist.
 * `lookupPrefix(prefix)` returns [key, envelope][] for keys starting with prefix.
 * Returns { status, body }.
 */
export async function resolveRead(path, params, { lookup, lookupPrefix }) {
  if (path === '/spend') {
    const group = params.get('group_by') ?? 'project';
    const rows = await lookupPrefix(`/spend/day/${group}/`);
    if (!rows.length) return notSynced();
    const days = rows.map(([k, env]) => [k.slice(`/spend/day/${group}/`.length), env]);
    return { status: 200, body: sumSpend(days, params) };
  }

  const exact = mirrorKey(path, params);
  const route = Object.hasOwn(LISTS, path) ? path : null;
  const found = await lookup(route ? [exact, path] : [exact]);
  if (found.has(exact) && !route) return { status: 200, body: found.get(exact) };
  if (route && found.has(path)) {
    const filtered = filterList(route, found.get(path), stripPaging(params, route));
    return { status: 200, body: filtered };
  }
  if (found.has(exact)) return { status: 200, body: found.get(exact) };

  const status = await lookup(['/status']);
  if (!status.has('/status')) return notSynced();
  return {
    status: 404,
    body: {
      error: {
        code: 'not_found',
        message: 'Not in the mirror. Either fwd has no such record, or the relay has not copied it yet.',
        details: { path },
      },
    },
  };
}

function stripPaging(params, _route) {
  const out = new URLSearchParams();
  for (const [k, v] of params) if (!PAGING.has(k) || k === 'limit') out.set(k, v);
  return out;
}

function notSynced() {
  return {
    status: 503,
    body: {
      error: {
        code: 'not_synced',
        message: 'Nothing has been synced from your machine yet. Start the relay next to fwd.',
        details: {},
      },
    },
  };
}
