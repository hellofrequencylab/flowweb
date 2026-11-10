import { api } from '../api/client';
import { useStatusResource } from '../api/live';
import { useResource } from '../api/resource';
import type { DawnLog as Dawn, FlowRunList, RowList, Status } from '../api/types';
import { FlowBoard, inFlight, LaneOrbits } from '../ledger/FlowBoard';
import { LandedProven } from '../rewards/Rewards';
import { usePrefs } from '../shell/prefs';
import { Link } from '../shell/router';
import { Donut, FlowRing, Gauge, IconTile, Legend, type Slice } from '../ui-kit/flow';
import { AsOf, Empty, Fact, LoadError, Loading, StaleNotice } from '../ui-kit/honest';
import { SectionHead } from '../ui-kit/page';
import { PROBE_STATUS, StatusLabel } from '../ui-kit/status';
import { clock, usd, useNow, when } from '../ui-kit/time';

const unknown = <span className="fact-unknown">Unknown</span>;

/**
 * The build tracker: lanes, every change in flight, what landed and what merged but is not proven yet,
 * run outcomes, spend and integrity. It was the home page; now it is a block another page mounts
 * (Under the hood), so home can answer what to do today.
 */
export function BuildOverview() {
  const dawn = useResource('dawn', api.dawn, ['dawn', 'rows', 'runs']);
  const flowRuns = useResource('flow-runs', api.flowRuns, ['dawn', 'runs']);
  const st = useStatusResource();
  const rowsRes = useResource<RowList>('rows', () => api.rows(), ['rows']);
  const moving = rowsRes.data?.rows.filter(inFlight) ?? [];
  const now = useNow();
  const s = st.data;
  const d = dawn.data;
  const { prefs } = usePrefs();
  const rewards = prefs.rewards && prefs.rewardCargoLanded;
  const live = st.honesty === 'current' && s;

  return (
    <div className="build-overview">
      {dawn.honesty === 'loading' && <Loading what="the build log" />}
      {!d && dawn.honesty !== 'loading' && (
        <LoadError what="the build log" error={dawn.error} onRetry={dawn.reload} />
      )}
      {d && dawn.honesty === 'stale' && <StaleNotice res={dawn} what="build log" />}
      {d && (
        <>
          {rowsRes.data && (
            <section className="section" aria-labelledby="dawn-lanes">
              <SectionHead
                id="dawn-lanes"
                overline={`${new Set(rowsRes.data.rows.map((r) => r.lane)).size} lanes · ${moving.length} changes moving`}
                title="Your lanes"
                meta={<AsOf res={rowsRes} />}
              />
              <LaneOrbits rows={rowsRes.data.rows} />
            </section>
          )}

          {rowsRes.data && moving.length > 0 && (
            <section className="section" aria-labelledby="dawn-flow">
              <SectionHead
                id="dawn-flow"
                overline="Queued, build, check, sign-off, landed"
                title="Every change in flight"
                meta={
                  <Link to="/ledger" className="small">
                    All of Logs
                  </Link>
                }
              />
              <FlowBoard rows={moving} label="Changes in flight" />
            </section>
          )}

          <section className="section" aria-labelledby="dawn-landed">
            <SectionHead
              id="dawn-landed"
              overline="Probe passed on the merged code"
              title={`Landed since ${when(d.since, now)}`}
              meta={`${d.rows_done.length} row${d.rows_done.length === 1 ? '' : 's'}`}
            />
            {d.rows_done.length === 0 ? (
              <Empty>No rows reached Done. Checked the logs at {clock(d.data_as_of)}.</Empty>
            ) : (
              <ul className="item-list">
                {d.rows_done.map((r) => (
                  <li key={r.ledger_row_id} className="item item-ring">
                    <span className="item-ring-mark">
                      <FlowRing hue="teal" at={4} state="done" size={30} title="" />
                      <StatusLabel plain spec={{ word: 'Done', tone: 'ok', icon: 'done' }} />
                    </span>
                    <div className="item-main">
                      <Link to={`/ledger/${r.ledger_row_id}`} className="item-title">
                        <span className="mono item-id">{r.row_id}</span> {r.title}
                      </Link>
                      <span className="item-meta">
                        merged <span className="mono">{r.merged_sha.slice(0, 7) || 'unknown'}</span>
                        {' · '}
                        <Link to={`/ledger/${r.ledger_row_id}#probe`}>
                          Probe {PROBE_STATUS[r.probe_status].word.toLowerCase()}{' '}
                          {r.probe_at ? clock(r.probe_at) : ''}
                        </Link>
                      </span>
                      {rewards && r.probe_status === 'pass' && r.merged_sha && (
                        <LandedProven
                          rowId={r.row_id}
                          ledgerRowId={r.ledger_row_id}
                          title={r.title}
                          sha={r.merged_sha}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.rows_watching.length > 0 && (
            <section className="section" aria-labelledby="dawn-watching">
              <SectionHead
                id="dawn-watching"
                overline="Merged, probe not yet passed"
                title="Merged, watching"
                meta={`${d.rows_watching.length} row${d.rows_watching.length === 1 ? '' : 's'}`}
              />
              <ul className="item-list">
                {d.rows_watching.map((r) => (
                  <li key={r.ledger_row_id} className="item item-ring">
                    <span className="item-ring-mark">
                      <FlowRing hue="slate" at={4} state="held" size={30} title="" />
                      <StatusLabel
                        plain
                        spec={{ word: 'Not verified', tone: 'unknown', icon: 'notverified' }}
                      />
                    </span>
                    <div className="item-main">
                      <Link to={`/ledger/${r.ledger_row_id}`} className="item-title">
                        <span className="mono item-id">{r.row_id}</span> {r.title}
                      </Link>
                      <span className="item-meta">Probe has not passed on the merged code yet.</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="section dash-grid">
            <RunsTile
              d={d}
              flows={flowRuns.honesty === 'current' ? flowRuns.data : null}
              label={`Runs since ${when(d.since, now)}`}
            />

            <section className="panel dash-tile" aria-labelledby="dawn-spend">
              <div className="panel-head">
                <h2 id="dawn-spend">Spend today</h2>
                <Link to="/spend" className="small">
                  Details
                </Link>
              </div>
              <div className="dash-tile-body">
                {live && s.spend_today ? (
                  <Gauge
                    size={176}
                    label="Spend today against the daily cap"
                    valueText={`${usd(s.spend_today.usd, s.spend_today.estimated)} of ${usd(s.spend_today.cap_usd)}`}
                    value={s.spend_today.usd}
                    cap={s.spend_today.cap_usd}
                    forecast={s.spend_today.forecast_usd}
                    center={usd(s.spend_today.usd)}
                    sub={`${s.spend_today.estimated ? 'est., ' : ''}of ${usd(s.spend_today.cap_usd)}`}
                  />
                ) : (
                  <Gauge size={176} label="Spend today" value={null} cap={1} center={unknown} />
                )}
              </div>
              {live &&
                s.spend_today?.vendors_configured &&
                s.spend_today.vendors_reporting.length < s.spend_today.vendors_configured.length && (
                  <p className="small muted">
                    Partial: {s.spend_today.vendors_reporting.length} of{' '}
                    {s.spend_today.vendors_configured.length} vendors reporting.
                  </p>
                )}
            </section>

            <section className="panel dash-tile" aria-labelledby="dawn-integrity">
              <div className="panel-head">
                <h2 id="dawn-integrity">Integrity</h2>
              </div>
              <Fact
                res={st}
                pick={(x: Status) => x.integrity}
                format={(i) => (
                  <div className="dash-tile-body integrity-tile">
                    <IconTile
                      name={i.ok ? 'verified' : 'shield-x'}
                      tone={i.ok ? 'verified' : 'fail'}
                      size="lg"
                    />
                    <span className="integrity-text">
                      <StatusLabel
                        plain
                        spec={
                          i.ok
                            ? { word: 'Verified', tone: 'ok', icon: 'verified' }
                            : {
                                word: `Failed at #${i.failed_at_seq ?? '?'}`,
                                tone: 'fail',
                                icon: 'shield-x',
                              }
                        }
                      />
                      <span className="integrity-seq">#{i.verified_up_to_seq}</span>
                      <span className="small muted">events checked, at {clock(i.checked_at)}</span>
                    </span>
                  </div>
                )}
              />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Run outcomes as a donut, with the words and links in the legend. Agent runs and flow cycles both
 * count: fwd keeps a flow cycle as a status report, not a run, so on a machine that only runs flows
 * the agent count alone would always read 0. A drafted, dry or published cycle succeeded.
 */
function RunsTile({ d, flows, label }: { d: Dawn; flows: FlowRunList | null; label: string }) {
  const cycles = (flows?.flow_runs ?? []).filter((r) => r.kind === 'cycle' && r.ended_at >= d.since);
  const ok = cycles.filter(
    (r) => r.outcome === 'drafted' || r.outcome === 'dry' || r.outcome === 'published',
  );
  const bad = cycles.filter((r) => r.outcome === 'failed');
  const runs = {
    succeeded: d.runs.succeeded + ok.length,
    failed: d.runs.failed + bad.length,
    halted: d.runs.halted,
    total: d.runs.total + cycles.length,
  };
  const other = Math.max(0, runs.total - runs.succeeded - runs.failed - runs.halted);
  const slices: Slice[] = [
    { key: 'succeeded', label: 'Succeeded', value: runs.succeeded, tone: 'ok' },
    { key: 'failed', label: 'Failed', value: runs.failed, tone: 'fail' },
    { key: 'halted', label: 'Halted', value: runs.halted, tone: 'stop' },
    ...(other ? [{ key: 'other', label: 'Other', value: other, tone: 'neutral' } as Slice] : []),
  ];
  return (
    <section className="panel dash-tile" aria-labelledby="dawn-runs">
      <div className="panel-head">
        <h2 id="dawn-runs">{label}</h2>
        <Link to="/runs" className="small">
          All runs
        </Link>
      </div>
      <div className="dash-tile-body">
        <Donut
          slices={slices}
          center={runs.total}
          sub="finished"
          label={`${runs.total} runs finished: ${slices.map((x) => `${x.value} ${x.label.toLowerCase()}`).join(', ')}`}
        />
        <Legend slices={slices} hrefFor={(x) => (x.key === 'other' ? undefined : `/runs?status=${x.key}`)} />
      </div>
      {!flows && <p className="small muted">Agent runs only: flow cycles are Unknown until fwd answers.</p>}
    </section>
  );
}
