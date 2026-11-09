import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { RowStatus, RowSummary } from '../api/types';
import { ProjectsSummary } from '../projects/ProjectsPage';
import { Link, useRouter } from '../shell/router';
import { AsOf, Empty, ResourceView } from '../ui-kit/honest';
import { PageHead, SectionHead } from '../ui-kit/page';
import { probeSpec, ROW_STATUS, StatusLabel } from '../ui-kit/status';
import { age, useNow } from '../ui-kit/time';

const ORDER: RowStatus[] = [
  'awaiting_approval',
  'blocked',
  'regressed',
  'running',
  'verifying',
  'merging',
  'claimed',
  'watching',
  'ready',
  'open',
  'parked',
  'done',
];
const PRI = { P0: 0, P1: 1, P2: 2, P3: 3 };

function sortRows(rows: RowSummary[]) {
  return [...rows].sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      PRI[a.priority] - PRI[b.priority] ||
      a.row_id.localeCompare(b.row_id),
  );
}

export function LedgerPage() {
  const { loc, go } = useRouter();
  const status = loc.query.get('status') ?? '';
  const priority = loc.query.get('priority') ?? '';
  const lane = loc.query.get('lane') ?? '';
  const res = useResource('rows', () => api.rows(), ['rows']);
  const now = useNow();

  const setFilter = (k: string, v: string) => {
    const q = new URLSearchParams(loc.query);
    if (v) q.set(k, v);
    else q.delete(k);
    go(`/ledger${q.toString() ? `?${q}` : ''}`);
  };

  return (
    <>
      <PageHead
        title={<>Projects and ledger</>}
        lede={
          <>
            Every row, its status and its last probe. Waiting on you first.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
      />
      <ProjectsSummary />
      <div className="section">
        <SectionHead title="Ledger" overline="One row per change, each with a probe" />
      </div>
      <ResourceView res={res} what="ledger">
        {(d) => {
          const lanes = [...new Set(d.rows.map((r) => r.lane))].sort();
          const rows = sortRows(
            d.rows.filter(
              (r) =>
                (!status || r.status === status) &&
                (!priority || r.priority === priority) &&
                (!lane || r.lane === lane),
            ),
          );
          return (
            <>
              <fieldset className="filters">
                <legend className="visually-hidden">Filters</legend>
                <label>
                  Status
                  <select value={status} onChange={(e) => setFilter('status', e.target.value)}>
                    <option value="">All</option>
                    {ORDER.map((s) => (
                      <option key={s} value={s}>
                        {ROW_STATUS[s].word}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select value={priority} onChange={(e) => setFilter('priority', e.target.value)}>
                    <option value="">All</option>
                    {['P0', 'P1', 'P2', 'P3'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Lane
                  <select value={lane} onChange={(e) => setFilter('lane', e.target.value)}>
                    <option value="">All</option>
                    {lanes.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </label>
              </fieldset>
              <p className="small muted">
                {rows.length} of {d.rows.length} rows. Waiting on you first.
              </p>
              {rows.length === 0 ? (
                <Empty title="No rows match">Nothing in the ledger matches these filters.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Title</th>
                        <th>Status</th>
                        <th>Pri</th>
                        <th className="hide-narrow">Lane</th>
                        <th className="hide-narrow">Depends on</th>
                        <th className="hide-narrow">Last probe</th>
                        <th className="hide-narrow">Last run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.ledger_row_id}>
                          <td className="mono">
                            <Link to={`/ledger/${r.ledger_row_id}`}>{r.row_id}</Link>
                          </td>
                          <td>{r.title}</td>
                          <td>
                            <StatusLabel spec={ROW_STATUS[r.status]} />
                            {r.blocked_reason && <div className="xs muted">{r.blocked_reason}</div>}
                          </td>
                          <td>{r.priority}</td>
                          <td className="hide-narrow">{r.lane}</td>
                          <td className="hide-narrow mono xs">{r.depends_on.join(', ') || 'none'}</td>
                          <td className="hide-narrow">
                            <StatusLabel
                              spec={probeSpec(r.last_probe.status, r.last_probe.target_kind ?? undefined)}
                            />
                            {r.last_probe.at && <div className="xs muted">{age(r.last_probe.at, now)}</div>}
                          </td>
                          <td className="hide-narrow mono xs">
                            {r.last_run_id ? (
                              <Link to={`/runs/${r.last_run_id}`}>{r.last_run_id}</Link>
                            ) : (
                              'none'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
