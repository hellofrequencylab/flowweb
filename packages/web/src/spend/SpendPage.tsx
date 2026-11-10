import { useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { SpendToday } from '../api/types';
import { Donut, Gauge, hueAt, IconTile, Legend, type Slice } from '../ui-kit/flow';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { Figures, PageHead } from '../ui-kit/page';
import { StatusLabel } from '../ui-kit/status';
import { usd, useNow, when } from '../ui-kit/time';

/** Read-only. No red for spend, and no reward for spending or saving. */
export function SpendPage() {
  const res = useResource('spend', api.spend, ['spend']);
  const now = useNow();
  const [asTable, setAsTable] = useState(false);
  return (
    <>
      <PageHead
        overline="Read-only"
        title="Spend"
        lede={
          <>
            What agents cost today and this week. Caps live in the policy file.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
        aside={
          <Figures
            label="Spend at a glance"
            items={[
              res.honesty === 'current' && res.data?.today
                ? {
                    label: res.data.today.estimated ? 'today, estimated' : 'today',
                    value: usd(res.data.today.usd),
                    of: `of ${usd(res.data.today.cap_usd)}`,
                  }
                : { label: 'today', value: <span className="fact-unknown">Unknown</span> },
              res.honesty === 'current' && res.data
                ? {
                    label: `last ${res.data.by_day.length} days`,
                    value: usd(res.data.by_day.reduce((a, x) => a + x.usd, 0)),
                  }
                : { label: 'last 7 days', value: <span className="fact-unknown">Unknown</span> },
              res.honesty === 'current' && res.data
                ? {
                    label: 'stopped by a cap',
                    value: res.data.refused.length,
                  }
                : { label: 'stopped by a cap', value: <span className="fact-unknown">Unknown</span> },
            ]}
          />
        }
      />
      <ResourceView res={res} what="spend">
        {(d) => (
          <div className="stack-lg">
            <section className="panel">
              <h2>Today</h2>
              {d.today ? (
                <div className="dash-hero">
                  <Gauge
                    size={220}
                    label="Spend today against the daily cap"
                    valueText={`${usd(d.today.usd, d.today.estimated)} of ${usd(d.today.cap_usd)}`}
                    value={d.today.usd}
                    cap={d.today.cap_usd}
                    forecast={d.today.forecast_usd}
                    center={usd(d.today.usd)}
                    sub={`${d.today.estimated ? 'est., ' : ''}of ${usd(d.today.cap_usd)}`}
                  />
                  <Meter t={d.today} />
                </div>
              ) : (
                <div className="dash-hero">
                  <Gauge
                    size={220}
                    label="Spend today"
                    value={null}
                    cap={1}
                    center={<span className="fact-unknown">Unknown</span>}
                  />
                  <p className="fact-unknown">Unknown. fwd does not report today's spend yet.</p>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Last 7 days</h2>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setAsTable((v) => !v)}
                  aria-pressed={asTable}
                >
                  {asTable ? 'Show chart' : 'Show table'}
                </button>
              </div>
              {asTable ? (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="num">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.by_day.map((x) => (
                      <tr key={x.day}>
                        <td>{x.day}</td>
                        <td className="num">{usd(x.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <DayBars days={d.by_day} cap={d.today?.cap_usd} />
              )}
            </section>

            <div className="dash-grid">
              <section className="panel">
                <h2>By project</h2>
                <Groups groups={d.by_project} what="project" />
              </section>
              <section className="panel">
                <h2>By vendor</h2>
                <Groups groups={d.by_vendor} what="vendor" />
              </section>
            </div>

            <section className="panel">
              <h2>Refused or stopped by a cap</h2>
              {d.refused.length === 0 ? (
                <p className="muted">None in the recent event log.</p>
              ) : (
                <ul className="plain-list">
                  {d.refused.map((r) => (
                    <li key={r.seq} className="row">
                      <span className="mono xs">{r.type}</span>
                      <span>{r.summary}</span>
                      <span className="spacer" />
                      <span className="asof">{when(r.at, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <h2>Budget breaker</h2>
              {d.breaker ? (
                <div className="breaker-row">
                  <IconTile
                    name={d.breaker.tripped ? 'paused' : 'gauge'}
                    tone={d.breaker.tripped ? 'caution' : 'neutral'}
                    size="lg"
                  />
                  <div>
                    <p>
                      {d.breaker.tripped ? (
                        <StatusLabel
                          spec={{
                            word: `Tripped: ${d.breaker.reason ?? 'no reason given'}`,
                            tone: 'warn',
                            icon: 'paused',
                          }}
                        />
                      ) : (
                        <StatusLabel spec={{ word: 'Not tripped', tone: 'neutral', icon: 'open' }} />
                      )}
                    </p>
                    <p className="small muted">
                      Trips at{' '}
                      {d.breaker.daily_usd != null
                        ? `${usd(d.breaker.daily_usd)} a day`
                        : 'an unknown daily amount'}
                      {d.breaker.velocity_usd_per_hour != null
                        ? ` or ${usd(d.breaker.velocity_usd_per_hour)} an hour`
                        : ''}
                      .
                    </p>
                  </div>
                </div>
              ) : (
                <p className="fact-unknown">Unknown</p>
              )}
              <p className="small muted">
                Caps and the breaker are changed only in the policy file, not here.
              </p>
            </section>
          </div>
        )}
      </ResourceView>
    </>
  );
}

function Meter({ t }: { t: SpendToday }) {
  const partial = t.vendors_configured && t.vendors_reporting.length < t.vendors_configured.length;
  return (
    <div className="stack">
      <p className="spend-now">
        {usd(t.usd, t.estimated)} <span className="muted">of {usd(t.cap_usd)} daily cap</span>
      </p>
      <p className="small muted">
        The dial's tick marks the cap.
        {t.forecast_usd
          ? ` The dotted arc is today's forecast: ${usd(t.forecast_usd, true)}.`
          : ' No forecast.'}
        {` ${Math.round((t.usd / t.cap_usd) * 100)}% of the cap is used.`}
      </p>
      {partial ? (
        <p className="callout callout-warn small">
          Partial: {t.vendors_reporting.length} of {t.vendors_configured!.length} vendors reporting (
          {t.vendors_reporting.join(', ') || 'none'}). The real total may be higher.
        </p>
      ) : (
        <p className="small muted">Reporting: {t.vendors_reporting.join(', ') || 'no vendors'}.</p>
      )}
    </div>
  );
}

function DayBars({ days, cap }: { days: { day: string; usd: number }[]; cap?: number }) {
  const max = Math.max(cap ?? 0, ...days.map((d) => d.usd), 1) * 1.05;
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <figure className="day-bars" aria-label="Spend per day for the last 7 days">
      <div className="day-bars-plot">
        {cap !== undefined && (
          <span className="day-bars-cap" style={{ bottom: pct(cap) }} aria-hidden="true">
            <span>cap {usd(cap)}</span>
          </span>
        )}
        {days.map((d, i) => (
          <div key={d.day} className="day-bar-col">
            <span className="day-bar-value">{usd(d.usd)}</span>
            <span
              className={`day-bar${i === days.length - 1 ? ' is-today' : ''}`}
              style={{ height: pct(d.usd) }}
              role="img"
              aria-label={`${d.day}: ${usd(d.usd)}`}
            />
          </div>
        ))}
      </div>
      <div className="day-bars-axis" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day}>
            {i === days.length - 1
              ? 'Today'
              : new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}
          </span>
        ))}
      </div>
    </figure>
  );
}

function Groups({ groups, what }: { groups: { key: string; label: string; usd: number }[]; what: string }) {
  if (groups.length === 0) return <p className="muted">No spend recorded.</p>;
  const total = groups.reduce((a, g) => a + g.usd, 0);
  const slices: Slice[] = groups.map((g, i) => ({
    key: g.key,
    label: g.label,
    value: g.usd,
    display: usd(g.usd),
    tone: 'neutral',
    hue: hueAt(i),
  }));
  return (
    <div className="dash-tile-body">
      <Donut
        slices={slices}
        center={usd(total)}
        sub={`${groups.length} ${what}${groups.length === 1 ? '' : 's'}`}
        label={`Spend by ${what}: ${groups.map((g) => `${g.label} ${usd(g.usd)}`).join(', ')}`}
      />
      <Legend slices={slices} />
    </div>
  );
}
