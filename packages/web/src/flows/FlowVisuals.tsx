import type { CSSProperties, ReactNode } from 'react';
import type { ActivationMeasures, ActivationTerritory } from '../api/types';
import { Gauge, type Hue, hueAt, Legend, ShareBar, type Slice } from '../ui-kit/flow';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (n: number) => n.toLocaleString('en-US');

/* -------------------------------------------------------------- RegionPath */

const REGION_WORD: Record<ActivationTerritory['status'], string> = {
  active: 'Active now',
  upkeep: 'Upkeep',
  waiting: 'Not opened',
};

/** Regions in the order the flow opens them, as one line: done regions filled, the active one marked. */
export function RegionPath({ territories, hue = 'teal' }: { territories: ActivationTerritory[]; hue?: Hue }) {
  const ts = [...territories].sort((a, b) => a.order - b.order);
  const n = ts.length;
  const at = ts.findIndex((t) => t.status === 'active');
  const lastDone = ts.reduce((k, t, i) => (t.status === 'upkeep' ? i : k), -1);
  const reach = Math.max(at, lastDone);
  const mid = (i: number) => `${((i + 0.5) / n) * 100}%`;
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  return (
    <div className="region-path" style={{ '--c': `var(--flow-${hue})` } as CSSProperties}>
      <div className="flow-track" aria-hidden="true" style={cols}>
        <span className="flow-track-base" style={{ left: mid(0), right: `calc(100% - ${mid(n - 1)})` }} />
        {reach > 0 && (
          <span
            className="flow-track-fill"
            style={{ left: mid(0), width: `calc(${mid(reach)} - ${mid(0)})` }}
          />
        )}
        {ts.map((t) => (
          <span
            key={t.id}
            className={`flow-node${t.status === 'active' ? ' is-here' : t.status === 'upkeep' ? ' is-passed' : ''}`}
          />
        ))}
      </div>
      <ol className="region-path-labels" style={cols}>
        {ts.map((t) => (
          <li key={t.id} className={t.status === 'active' ? 'is-here' : undefined}>
            <span className="region-path-name">{t.name}</span>
            <span className="region-path-word">
              {REGION_WORD[t.status]}
              {t.progress != null && t.status !== 'waiting' ? ` · ${pct(t.progress)}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------ MeasureDials */

/** One dial per activation measure, each against its target. Unknown stays Unknown, never zero. */
export function MeasureDials({
  t,
  measures,
}: {
  t: ActivationTerritory;
  measures: { key: keyof ActivationMeasures; label: string }[];
}) {
  const m = t.measures;
  return (
    <ul className="dials">
      {measures.map(({ key, label }) => {
        const target = t.targets[key];
        const v = m ? m[key] : null;
        return (
          <li key={key} className="dial">
            <Gauge
              size={124}
              value={v}
              cap={target}
              label={`${label} in ${t.name}`}
              valueText={v == null ? undefined : `${num(v)} of ${num(target)}`}
              center={v == null ? <span className="dial-unknown">Unknown</span> : num(v)}
              sub={`of ${num(target)}`}
            />
            <span className="dial-caption">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------ PipelineBar */

/** Counts by stage as one bar, with the legend carrying the words and numbers. */
export function PipelineBar({
  stages,
  counts,
  label,
}: {
  stages: { key: string; label: string }[];
  counts: Record<string, number>;
  label: string;
}): ReactNode {
  const slices: Slice[] = stages.map((s, i) => ({
    key: s.key,
    label: s.label,
    value: counts[s.key] ?? 0,
    tone: 'neutral',
    hue: hueAt(i),
  }));
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <div className="pipeline">
      <ShareBar
        slices={slices}
        label={`${label}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}. ${total} in all.`}
      />
      <Legend slices={slices} />
    </div>
  );
}
