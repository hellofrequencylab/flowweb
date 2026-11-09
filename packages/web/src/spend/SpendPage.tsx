import { useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { SpendToday } from '../api/types';
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
                <Meter t={d.today} />
              ) : (
                <p className="fact-unknown">Unknown. fwd does not report today's spend yet.</p>
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

            <div className="grid-2">
              <section className="panel">
                <h2>By project</h2>
                <Groups groups={d.by_project} />
              </section>
              <section className="panel">
                <h2>By vendor</h2>
                <Groups groups={d.by_vendor} />
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
                <>
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
                </>
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
  const pct = Math.min(100, (t.usd / t.cap_usd) * 100);
  const fpct = t.forecast_usd ? Math.min(100, (t.forecast_usd / t.cap_usd) * 100) : null;
  const partial = t.vendors_configured && t.vendors_reporting.length < t.vendors_configured.length;
  return (
    <div className="stack">
      <p className="spend-now">
        {usd(t.usd, t.estimated)} <span className="muted">of {usd(t.cap_usd)} daily cap</span>
      </p>
      {/* Decorative: the sentence above states spend and cap in words. */}
      <div className="meter" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${pct}%` }} />
        {fpct !== null && <span className="meter-cap" title="Forecast" style={{ left: `${fpct}%` }} />}
      </div>
      <p className="small muted">
        Cap marked at the right edge.
        {t.forecast_usd ? ` Forecast for today: ${usd(t.forecast_usd, true)}.` : ' No forecast.'}
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
  const max = Math.max(cap ?? 0, ...days.map((d) => d.usd), 1);
  const H = 120;
  const T = 16; // room for the cap label
  return (
    <figure className="bars-figure">
      <svg
        className="bars"
        viewBox={`0 ${-T} ${days.length * 48} ${H + 36 + T}`}
        role="img"
        aria-label="Spend per day for the last 7 days"
      >
        {cap !== undefined && (
          <>
            <line
              x1="0"
              x2={days.length * 48}
              y1={H - (cap / max) * H}
              y2={H - (cap / max) * H}
              className="cap-line"
              strokeDasharray="4 3"
            />
            <text x="2" y={H - (cap / max) * H - 4} fontSize="10">
              cap {usd(cap)}
            </text>
          </>
        )}
        {days.map((d, i) => {
          const h = (d.usd / max) * H;
          return (
            <g key={d.day}>
              <rect
                x={i * 48 + 10}
                y={H - h}
                width="28"
                height={h}
                rx="8"
                className={i === days.length - 1 ? 'bar bar-today' : 'bar'}
              />
              <text x={i * 48 + 24} y={H + 14} fontSize="10" textAnchor="middle" className="bar-day">
                {d.day.slice(5)}
              </text>
              <text x={i * 48 + 24} y={H + 28} fontSize="10" textAnchor="middle">
                {usd(d.usd)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function Groups({ groups }: { groups: { key: string; label: string; usd: number }[] }) {
  if (groups.length === 0) return <p className="muted">No spend recorded.</p>;
  return (
    <table className="data">
      <tbody>
        {groups.map((g) => (
          <tr key={g.key}>
            <td>{g.label}</td>
            <td className="num">{usd(g.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
