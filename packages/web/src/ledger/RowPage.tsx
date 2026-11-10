import { api } from '../api/client';
import { useResource } from '../api/resource';
import { EventList } from '../runs/RunPage';
import { RunsTable } from '../runs/RunsPage';
import { Link } from '../shell/router';
import { AsOf, Copy, ResourceView } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { PageHead } from '../ui-kit/page';
import { PROBE_STATUS, probeSpec, ROW_STATUS, StatusLabel } from '../ui-kit/status';
import { age, shortHash, useNow, when } from '../ui-kit/time';

export function RowPage({ id }: { id: string }) {
  const res = useResource(`row:${id}`, () => api.row(id), ['rows', 'runs']);
  const events = useResource(`row-events:${id}`, () => api.events({ limit: 20 }), ['rows']);
  const now = useNow();
  return (
    <ResourceView res={res} what="row">
      {(d) => {
        const r = d.row;
        return (
          <div className="stack">
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/ledger">
                <Icon name="arrow-left" /> Logs
              </Link>
            </nav>
            <PageHead
              overline={<span className="mono">{r.row_id}</span>}
              title={r.title}
              lede={
                <span className="page-meta">
                  <AsOf res={res} />
                </span>
              }
            />
            <p className="row">
              <StatusLabel spec={ROW_STATUS[r.status]} />
              {r.blocked_reason && <span>{r.blocked_reason}</span>}
              <span className="muted small">
                {r.priority} · {r.lane} · size {r.size}
              </span>
            </p>
            {r.description && <p>{r.description}</p>}

            <section className="panel" id="probe" aria-labelledby="probe-h">
              <div className="panel-head">
                <h2 id="probe-h">Probe</h2>
                <span className="status status-neutral">
                  <Icon name="lock" /> Human-only. Agents cannot change this.
                </span>
              </div>
              <p>
                <strong>What it measures:</strong> {r.probe.measures}
              </p>
              <p className="row">
                <code>{r.probe.command}</code> <Copy text={r.probe.command} label="probe command" />
              </p>
              <dl className="facts">
                <dt>Runs against</dt>
                <dd>{r.probe.runs_against.replace(/_/g, ' ')}</dd>
                <dt>Last result</dt>
                <dd>
                  <StatusLabel spec={probeSpec(r.last_probe.status, r.last_probe.target_kind ?? undefined)} />
                  {r.last_probe_detail?.at && (
                    <span className="muted small">
                      {' '}
                      {r.last_probe_detail.sha ? (
                        <>
                          on <span className="mono">{r.last_probe_detail.sha.slice(0, 7)}</span>,{' '}
                        </>
                      ) : (
                        ''
                      )}
                      {when(r.last_probe_detail.at, now)} ({age(r.last_probe_detail.at, now)})
                    </span>
                  )}
                  {r.last_probe_detail?.output_ref && (
                    <div className="xs mono muted">{r.last_probe_detail.output_ref}</div>
                  )}
                </dd>
                <dt>Premise re-tested</dt>
                <dd>
                  {r.premise ? (
                    <>
                      {when(r.premise.retested_at, now)}
                      {r.premise.still_valid === false
                        ? ' · premise no longer holds'
                        : r.premise.still_valid
                          ? ' · still valid'
                          : ''}
                    </>
                  ) : (
                    <StatusLabel spec={{ word: 'Never re-tested', tone: 'unknown', icon: 'notverified' }} />
                  )}
                </dd>
                <dt>Probe hash</dt>
                <dd className="hash">{shortHash(r.probe.content_hash, 12, 6)}</dd>
                {r.merged_sha && (
                  <>
                    <dt>Merged</dt>
                    <dd className="hash">{r.merged_sha.slice(0, 12)}</dd>
                  </>
                )}
              </dl>
            </section>

            <section className="panel" aria-labelledby="acc-h">
              <h2 id="acc-h">Acceptance</h2>
              {r.acceptance && r.acceptance.length > 0 ? (
                <ul className="plain-list">
                  {r.acceptance.map((a) => (
                    <li key={a.text} className="row" style={{ alignItems: 'flex-start' }}>
                      <StatusLabel spec={PROBE_STATUS[a.last_result]} />
                      <span style={{ flex: 1 }}>{a.text}</span>
                      {a.at && <span className="asof">{when(a.at, now)}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">fwd has not reported acceptance items for this row.</p>
              )}
            </section>

            <section className="panel" aria-labelledby="ev-h">
              <h2 id="ev-h">Evidence</h2>
              {d.evidence.length === 0 ? (
                <p className="muted">No evidence bundle yet.</p>
              ) : (
                <ul className="plain-list">
                  {d.evidence.map((e) => (
                    <li key={e.id} className="row">
                      <Link to={`/evidence/${e.id}`} className="mono">
                        {e.id}
                      </Link>
                      <span className="muted small">{when(e.created_at, now)}</span>
                      {e.scan_red && (
                        <StatusLabel spec={{ word: 'Security scan failed', tone: 'fail', icon: 'fail' }} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel" aria-labelledby="runs-h">
              <h2 id="runs-h">Runs for this row</h2>
              {d.runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
              ) : (
                <RunsTable runs={d.runs} compact />
              )}
            </section>

            <section className="panel" aria-labelledby="hist-h">
              <h2 id="hist-h">History</h2>
              <p className="xs muted">
                Recent events from the log. Per-row filtering arrives with the full events API.
              </p>
              <EventList res={events} />
            </section>
          </div>
        );
      }}
    </ResourceView>
  );
}
