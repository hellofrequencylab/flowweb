import { useState } from 'react';
import type { RowSummary } from '../api/types';
import {
  FlowLine,
  FlowOrbit,
  type FlowState,
  GroupBadge,
  hueFor,
  type OrbitItem,
  rowFlow,
  StageHeader,
} from '../ui-kit/flow';
import { Icon, type IconName } from '../ui-kit/Icon';
import { age, useNow } from '../ui-kit/time';

/** Rows that are moving or stuck: not yet started rows and finished rows are left out. */
export function inFlight(r: RowSummary) {
  return !['open', 'done', 'parked'].includes(r.status);
}

/** Sort: waiting on you, then problems, then running, then the rest. */
const RANK: Record<FlowState, number> = {
  waiting: 0,
  problem: 1,
  running: 2,
  held: 3,
  paused: 4,
  quiet: 5,
  unknown: 6,
  done: 7,
};
export const byUrgency = (a: RowSummary, b: RowSummary) =>
  RANK[rowFlow(a.status).state] - RANK[rowFlow(b.status).state] ||
  a.priority.localeCompare(b.priority) ||
  a.row_id.localeCompare(b.row_id);

type Filter = 'all' | 'todo' | 'waiting' | 'running' | 'problem' | 'done';
const FILTERS: { key: Filter; label: string; icon?: IconName }[] = [
  { key: 'all', label: 'All' },
  { key: 'todo', label: 'Not landed', icon: 'flow' },
  { key: 'waiting', label: 'Needs you', icon: 'waiting' },
  { key: 'running', label: 'Moving', icon: 'running' },
  { key: 'problem', label: 'Problems', icon: 'problem' },
  { key: 'done', label: 'Landed', icon: 'done' },
];
const matches = (f: Filter, r: RowSummary) => {
  const s = rowFlow(r.status).state;
  if (f === 'all') return true;
  if (f === 'todo') return s !== 'done';
  if (f === 'running') return s === 'running' || s === 'held';
  return s === f;
};

/** One orbit per lane: up to four rings for the changes moving in it. */
export function LaneOrbits({ rows, max = 8 }: { rows: RowSummary[]; max?: number }) {
  const lanes = [...new Set(rows.map((r) => r.lane))];
  const groups = lanes
    .map((lane) => {
      const moving = rows.filter((r) => r.lane === lane && inFlight(r)).sort(byUrgency);
      const items: OrbitItem[] = moving.map((r) => ({ key: r.ledger_row_id, ...rowFlow(r.status) }));
      return { lane, items, rank: items.length ? RANK[items[0].state] : 9 };
    })
    .sort((a, b) => a.rank - b.rank || b.items.length - a.items.length || a.lane.localeCompare(b.lane))
    .slice(0, max);
  return (
    <div className="flow-orbits">
      {groups.map((g) => (
        <FlowOrbit
          key={g.lane}
          name={g.lane}
          hue={hueFor(g.lane)}
          items={g.items}
          extra={Math.max(0, g.items.length - 4)}
          to={`/ledger?lane=${encodeURIComponent(g.lane)}`}
        />
      ))}
    </div>
  );
}

/** Every row as a FlowLine, grouped by lane, with state filters. */
export function FlowBoard({
  rows,
  filters = true,
  initial = 'all',
  label = 'Flow map',
}: {
  rows: RowSummary[];
  filters?: boolean;
  initial?: Filter;
  label?: string;
}) {
  const [filter, setFilter] = useState<Filter>(initial);
  const now = useNow(60_000);
  const shown = rows.filter((r) => matches(filter, r)).sort(byUrgency);
  const lanes = [...new Set(rows.map((r) => r.lane))].sort();
  return (
    <section aria-label={label}>
      {filters && (
        <fieldset className="flow-filters">
          <legend className="visually-hidden">Show</legend>
          {FILTERS.filter((f) => {
            const n = rows.filter((r) => matches(f.key, r)).length;
            return f.key === 'all' || (n > 0 && !(f.key === 'todo' && n === rows.length));
          }).map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.icon && <Icon name={f.icon} size={14} />}
              {f.label}
              <span className="n">{rows.filter((r) => matches(f.key, r)).length}</span>
            </button>
          ))}
        </fieldset>
      )}
      <div className="flow-map">
        <StageHeader />
        {lanes.map((lane) => {
          const mine = shown.filter((r) => r.lane === lane);
          if (!mine.length) return null;
          const waiting = mine.filter((r) => r.status === 'awaiting_approval').length;
          return (
            <div key={lane}>
              <div className="flow-group-head">
                <GroupBadge name={lane} hue={hueFor(lane)} size="sm" />
                <span className="flow-group-name">{lane}</span>
                <span className="flow-group-meta">
                  {mine.length} row{mine.length === 1 ? '' : 's'}
                  {waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}
                </span>
              </div>
              {mine.map((r) => {
                const f = rowFlow(r.status);
                return (
                  <FlowLine
                    key={r.ledger_row_id}
                    to={`/ledger/${r.ledger_row_id}`}
                    name={r.title}
                    meta={
                      <>
                        <span className="mono">{r.row_id}</span> · {r.priority}
                      </>
                    }
                    hue={hueFor(lane)}
                    {...f}
                    when={r.blocked_reason ?? `Updated ${age(r.updated_at, now)}`}
                  />
                );
              })}
            </div>
          );
        })}
        {shown.length === 0 && <p className="flow-map-empty">No rows in this view.</p>}
      </div>
    </section>
  );
}
