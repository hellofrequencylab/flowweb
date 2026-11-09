import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { RunStatus, RunSummary } from '../api/types';
import { Link, useRouter } from '../shell/router';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { runStatusSpec, SANDBOX, StatusLabel } from '../ui-kit/status';
import { duration, usd, useNow, when } from '../ui-kit/time';

/** UI filter words → which run statuses they include. */
const FILTERS: Record<string, { label: string; match: (s: RunStatus) => boolean }> = {
  active: {
    label: 'Active',
    match: (s) => ['queued', 'starting', 'running', 'paused', 'checking'].includes(s),
  },
  succeeded: { label: 'Succeeded', match: (s) => s === 'artifact_verified' || s === 'finished_unchecked' },
  failed: { label: 'Failed', match: (s) => ['failed', 'timed_out', 'claimed_unverified'].includes(s) },
  halted: { label: 'Halted by you', match: (s) => s === 'halted' },
  cancelled: { label: 'Cancelled', match: (s) => s === 'cancelled' },
};

export function RunsTable({ runs, compact = false }: { runs: RunSummary[]; compact?: boolean }) {
  const now = useNow(15_000);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Run</th>
            {!compact && <th>Row</th>}
            <th>Status</th>
            <th className="hide-narrow">Agent</th>
            <th className="hide-narrow">Started</th>
            <th className="hide-narrow num">Duration</th>
            <th className="num">Cost</th>
            <th className="hide-narrow">Sandbox</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const spec = runStatusSpec(r.status, r.heartbeat_at ?? undefined, now);
            return (
              <tr key={r.run_id}>
                <td className="mono">
                  <Link to={`/runs/${r.run_id}`}>{r.run_id}</Link>
                </td>
                {!compact && <td className="mono">{r.row_id ?? 'unknown'}</td>}
                <td>
                  <StatusLabel spec={spec} />
                </td>
                <td className="hide-narrow">
                  {r.role ?? 'agent'} · {r.vendor}
                </td>
                <td className="hide-narrow">{r.started_at ? when(r.started_at, now) : 'not started'}</td>
                <td className="hide-narrow num">
                  {r.started_at ? duration(r.started_at, r.ended_at, now) : ''}
                </td>
                <td className="num">{usd(r.cost_usd, r.cost_estimated)}</td>
                <td className="hide-narrow">
                  <StatusLabel spec={SANDBOX[r.sandbox]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RunsPage() {
  const { loc, go } = useRouter();
  const status = loc.query.get('status') ?? '';
  const vendor = loc.query.get('vendor') ?? '';
  const res = useResource('runs', () => api.runs(), ['runs']);
  const set = (k: string, v: string) => {
    const q = new URLSearchParams(loc.query);
    if (v) q.set(k, v);
    else q.delete(k);
    go(`/runs${q.toString() ? `?${q}` : ''}`);
  };
  return (
    <>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 tabIndex={-1}>Runs</h1>
        <span className="spacer" />
        <AsOf res={res} />
      </div>
      <ResourceView res={res} what="runs">
        {(d) => {
          const vendors = [...new Set(d.runs.map((r) => r.vendor))].sort();
          const runs = d.runs.filter(
            (r) => (!status || FILTERS[status]?.match(r.status)) && (!vendor || r.vendor === vendor),
          );
          return (
            <>
              <fieldset className="filters">
                <legend className="visually-hidden">Filters</legend>
                <label>
                  Status
                  <select value={status} onChange={(e) => set('status', e.target.value)}>
                    <option value="">All</option>
                    {Object.entries(FILTERS).map(([k, f]) => (
                      <option key={k} value={k}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Vendor
                  <select value={vendor} onChange={(e) => set('vendor', e.target.value)}>
                    <option value="">All</option>
                    {vendors.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </fieldset>
              {runs.length === 0 ? (
                <p className="muted">No runs match. Checked {d.runs.length} runs.</p>
              ) : (
                <RunsTable runs={runs} />
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
