import type { CSSProperties } from 'react';
import type { RunSummary } from '../api/types';
import { Link } from '../shell/router';
import { GroupBadge, hueFor } from '../ui-kit/flow';
import { runStatusSpec } from '../ui-kit/status';
import { clock, duration, usd } from '../ui-kit/time';

const HOUR = 3_600_000;

/**
 * Runs as bars on a time axis, one lane per agent (role and vendor). A run
 * still going reaches to now; a queued run with no start is left off and
 * counted under the chart instead of being drawn at a guessed time.
 */
export function RunsTimeline({ runs, now, hours = 24 }: { runs: RunSummary[]; now: number; hours?: number }) {
  const from = now - hours * HOUR;
  const placed = runs.filter((r) => r.started_at && new Date(r.ended_at ?? now).getTime() >= from);
  const unplaced = runs.filter((r) => !r.started_at).length;
  const lanes = [...new Set(placed.map((r) => `${r.role ?? 'agent'} · ${r.vendor}`))].sort();
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - from) / (now - from)) * 100))}%`;
  const ticks = Array.from({ length: hours / 6 + 1 }, (_, i) => from + i * 6 * HOUR);
  return (
    <section className="panel timeline" aria-labelledby="tl-h">
      <div className="panel-head">
        <h2 id="tl-h">Last {hours} hours</h2>
        <span className="asof">
          {placed.length} run{placed.length === 1 ? '' : 's'}
          {unplaced ? ` · ${unplaced} not started` : ''}
        </span>
      </div>
      {lanes.length === 0 ? (
        <p className="small muted">No runs started in the last {hours} hours.</p>
      ) : (
        <div className="timeline-grid">
          {lanes.map((lane) => {
            const vendor = lane.split(' · ')[1];
            return (
              <div key={lane} className="timeline-lane">
                <span className="timeline-label">
                  <GroupBadge name={vendor} hue={hueFor(vendor)} size="sm" />
                  {lane}
                </span>
                <ul className="timeline-track">
                  {placed
                    .filter((r) => `${r.role ?? 'agent'} · ${r.vendor}` === lane)
                    .map((r) => {
                      const s = new Date(r.started_at!).getTime();
                      const e = r.ended_at ? new Date(r.ended_at).getTime() : now;
                      const spec = runStatusSpec(r.status, r.heartbeat_at ?? undefined, now);
                      const live = !r.ended_at && spec.tone === 'active';
                      return (
                        <li
                          key={r.run_id}
                          className="timeline-item"
                          style={
                            {
                              left: pct(Math.max(s, from)),
                              width: `max(8px, calc(${pct(e)} - ${pct(Math.max(s, from))}))`,
                            } as CSSProperties
                          }
                        >
                          <Link
                            to={`/runs/${r.run_id}`}
                            className={`timeline-bar tone-${spec.tone}${live ? ' is-live' : ''}`}
                            aria-label={`${r.run_id}${r.row_id ? ` for ${r.row_id}` : ''}: ${spec.word}, started ${clock(r.started_at)}, ${duration(r.started_at!, r.ended_at, now)}, ${usd(r.cost_usd, r.cost_estimated)}`}
                            title={`${r.run_id} · ${spec.word} · ${usd(r.cost_usd, r.cost_estimated)}`}
                          >
                            {live && <span className="fw-motion timeline-light" />}
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </div>
            );
          })}
          <div className="timeline-axis" aria-hidden="true">
            <span />
            <span className="timeline-ticks">
              {ticks.map((t, i) => (
                <span key={t} style={{ left: pct(t) }}>
                  {i === ticks.length - 1 ? 'now' : clock(new Date(t).toISOString())}
                </span>
              ))}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
