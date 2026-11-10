import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { RowStatus, RowSummary } from '../api/types';
import { ProjectsSummary } from '../projects/ProjectsPage';
import { Link, useRouter } from '../shell/router';
import { FlowRing, GroupBadge, hueFor, rowFlow, ShareBar, STAGES, TallyMark } from '../ui-kit/flow';
import { AsOf, Empty, ResourceView } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { Figures, PageHead, SectionHead } from '../ui-kit/page';
import { probeSpec, ROW_STATUS, StatusLabel } from '../ui-kit/status';
import { age, useNow } from '../ui-kit/time';
import { FlowBoard, inFlight } from './FlowBoard';

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
  const view = loc.query.get('view') === 'table' || status || priority ? 'table' : 'map';
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
        title={<>Logs</>}
        lede={
          <>
            Every row, its status and its last probe. Waiting on you first.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
        aside={res.data ? <LoopSummary rows={res.data.rows} /> : undefined}
      />
      <ResourceView res={res} what="logs">
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
          const toggle = (
            <fieldset className="flow-filters view-toggle">
              <legend className="visually-hidden">View</legend>
              <button
                type="button"
                aria-pressed={view === 'map'}
                onClick={() => go(lane ? `/ledger?lane=${encodeURIComponent(lane)}` : '/ledger')}
              >
                <Icon name="flow" size={14} /> Flow map
              </button>
              <button
                type="button"
                aria-pressed={view === 'table'}
                onClick={() => setFilter('view', 'table')}
              >
                <Icon name="logs" size={14} /> Table
              </button>
            </fieldset>
          );
          if (view === 'map')
            return (
              <>
                <LaneBoard rows={d.rows} />
                <div className="section">
                  <SectionHead
                    title={lane ? `Lane ${lane}` : 'Every change'}
                    overline="Queued, build, check, sign-off, landed"
                    meta={
                      lane ? (
                        <Link to="/ledger" className="small">
                          Show every lane
                        </Link>
                      ) : undefined
                    }
                  />
                  {toggle}
                  <FlowBoard rows={rows} initial="todo" label={lane ? `Lane ${lane}` : 'Every change'} />
                </div>
              </>
            );
          return (
            <div className="section">
              <SectionHead title="Every change" overline="One row per change, each with a probe" />
              {toggle}
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
                        <th className="hide-narrow">Pri</th>
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
                          <td className="hide-narrow">{r.priority}</td>
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
            </div>
          );
        }}
      </ResourceView>
      <div className="section">
        <ProjectsSummary />
      </div>
    </>
  );
}

/** The whole ledger as one loop: how many rows sit at each stage, and how many have landed. */
function LoopSummary({ rows }: { rows: RowSummary[] }) {
  const at = STAGES.map(
    (_, i) => rows.filter((r) => rowFlow(r.status).at === i && r.status !== 'open').length,
  );
  const done = rows.filter((r) => r.status === 'done').length;
  const waiting = rows.filter((r) => r.status === 'awaiting_approval').length;
  return (
    <div className="loop-summary">
      <FlowRing
        size={230}
        hue="slate"
        at={4}
        state="done"
        tallies={at}
        showLabels
        label={`${done}`}
        sublabel={`of ${rows.length} landed`}
        title={`${done} of ${rows.length} rows landed. ${STAGES.map((s, i) => `${s} ${at[i]}`).join(', ')}.`}
      />
      <Figures
        label="Rows by stage"
        items={[
          { label: 'moving', value: rows.filter(inFlight).length },
          { label: 'need you', value: waiting, tone: waiting ? 'waiting' : undefined },
          { label: 'not started', value: rows.filter((r) => r.status === 'open').length },
        ]}
      />
    </div>
  );
}

/** One card per lane: its badge, a bar of where its rows are, and a tally of what landed. */
function LaneBoard({ rows }: { rows: RowSummary[] }) {
  const lanes = [...new Set(rows.map((r) => r.lane))].sort();
  return (
    <section className="section" aria-labelledby="lanes-h">
      <SectionHead id="lanes-h" title="Lanes" overline={`${lanes.length} lanes`} />
      <ul className="lane-grid">
        {lanes.map((lane) => {
          const mine = rows.filter((r) => r.lane === lane);
          const n = (f: (r: RowSummary) => boolean) => mine.filter(f).length;
          const done = n((r) => r.status === 'done');
          const waiting = n((r) => r.status === 'awaiting_approval');
          const problem = n((r) => rowFlow(r.status).state === 'problem');
          const moving = n(inFlight) - waiting - problem;
          const open = mine.length - done - waiting - problem - moving;
          return (
            <li key={lane}>
              <Link to={`/ledger?lane=${encodeURIComponent(lane)}`} className="lane-card">
                <span className="lane-card-head">
                  <GroupBadge name={lane} hue={hueFor(lane)} />
                  <strong>{lane}</strong>
                  <span className="muted small">{mine.length} rows</span>
                </span>
                <ShareBar
                  label={`${lane}: ${done} landed, ${moving} moving, ${waiting} need you, ${problem} problems, ${open} not started`}
                  slices={[
                    { key: 'done', label: 'Landed', value: done, tone: 'ok' },
                    { key: 'moving', label: 'Moving', value: moving, tone: 'active' },
                    { key: 'waiting', label: 'Needs you', value: waiting, tone: 'waiting' },
                    { key: 'problem', label: 'Problems', value: problem, tone: 'fail' },
                    { key: 'open', label: 'Not started', value: open, tone: 'unknown' },
                  ]}
                />
                <span className="lane-card-foot">
                  <TallyMark count={done} hue={hueFor(lane)} label={`${done} landed`} size={14} />
                  <span className="muted small">landed</span>
                  {waiting > 0 && (
                    <span className="lane-card-wait">
                      <Icon name="waiting" size={13} /> {waiting} need{waiting === 1 ? 's' : ''} you
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
