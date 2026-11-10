import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { FlowRun, RunList, RunStatus, RunSummary } from '../api/types';
import { Link, useRouter } from '../shell/router';
import { Donut, Legend, type Slice } from '../ui-kit/flow';
import { AsOf, Empty, ResourceView } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import { runStatusSpec, SANDBOX, StatusLabel } from '../ui-kit/status';
import { duration, usd, useNow, when } from '../ui-kit/time';
import { FlowRunsTable, flowFilterKey } from './FlowRuns';
import { RunsTimeline } from './RunsTimeline';

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

/** Agent runs and flow runs (FW-C-075), read together; the older of the two reads is the page's age. */
async function loadRuns(): Promise<RunList & { flow_runs: FlowRun[] }> {
  const [a, f] = await Promise.all([api.runs(), api.flowRuns()]);
  return { runs: a.runs, flow_runs: f.flow_runs, data_as_of: [a.data_as_of, f.data_as_of].sort()[0] };
}

export function RunsPage() {
  const { loc, go } = useRouter();
  const status = loc.query.get('status') ?? '';
  const vendor = loc.query.get('vendor') ?? '';
  const res = useResource('runs', loadRuns, ['runs', 'dawn']);
  const now = useNow(30_000);
  const all = res.data?.runs ?? [];
  const flows = res.data?.flow_runs ?? [];
  const total = all.length + flows.length;
  const TONES: Record<string, Slice['tone']> = {
    active: 'active',
    succeeded: 'ok',
    failed: 'fail',
    halted: 'stop',
    cancelled: 'neutral',
  };
  const slices: Slice[] = Object.entries(FILTERS).map(([k, f]) => ({
    key: k,
    label: f.label,
    value: all.filter((r) => f.match(r.status)).length + flows.filter((r) => flowFilterKey(r) === k).length,
    tone: TONES[k],
  }));
  const set = (k: string, v: string) => {
    const q = new URLSearchParams(loc.query);
    if (v) q.set(k, v);
    else q.delete(k);
    go(`/runs${q.toString() ? `?${q}` : ''}`);
  };
  return (
    <>
      <PageHead
        title={<>Runs</>}
        lede={
          <>
            Every agent run and flow run, live and finished.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
        aside={
          res.data ? (
            <div className="dash-tile-body runs-aside">
              <Donut
                slices={slices}
                center={total}
                sub="runs"
                label={`${total} runs: ${slices.map((x) => `${x.value} ${x.label.toLowerCase()}`).join(', ')}`}
              />
              <Legend slices={slices} hrefFor={(x) => `/runs?status=${x.key}`} />
            </div>
          ) : undefined
        }
      />
      <ResourceView res={res} what="runs">
        {(d) => {
          const vendors = [...new Set(d.runs.map((r) => r.vendor))].sort();
          const runs = d.runs.filter(
            (r) => (!status || FILTERS[status]?.match(r.status)) && (!vendor || r.vendor === vendor),
          );
          const flowRuns = d.flow_runs.filter((r) => !status || flowFilterKey(r) === status);
          return (
            <>
              <RunsTimeline runs={d.runs} flows={d.flow_runs} now={now} />
              <fieldset className="filters section">
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
              <section className="section" aria-labelledby="flow-runs-h">
                <div className="panel-head">
                  <h2 id="flow-runs-h">Flow runs</h2>
                  <span className="asof">{flowRuns.length} shown</span>
                </div>
                {flowRuns.length === 0 ? (
                  <p className="small muted">No flow cycles or digests match.</p>
                ) : (
                  <FlowRunsTable runs={flowRuns} />
                )}
              </section>
              <section className="section" aria-labelledby="agent-runs-h">
                <div className="panel-head">
                  <h2 id="agent-runs-h">Agent runs</h2>
                </div>
                {d.runs.length === 0 ? (
                  <p className="small muted">
                    No agent runs yet. They show here when an agent works a ledger row.
                  </p>
                ) : runs.length === 0 ? (
                  <Empty title="No runs match">Checked {d.runs.length} runs against these filters.</Empty>
                ) : (
                  <RunsTable runs={runs} />
                )}
              </section>
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
