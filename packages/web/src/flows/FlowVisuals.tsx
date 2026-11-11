import type { CSSProperties, ReactNode } from 'react';
import type { ActivationMeasures, ActivationTerritory, FlowDraft } from '../api/types';
import { Gauge, type Hue, hueAt, Legend, ShareBar, type Slice } from '../ui-kit/flow';
import { Icon } from '../ui-kit/Icon';
import { type Loop, type LoopInfo, useLoopTarget } from '../ui-kit/loop';
import { type DraftState, draftsPerDay } from './drafts';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (n: number) => n.toLocaleString('en-US');

/* -------------------------------------------------------------- RegionPath */

const REGION_WORD: Record<ActivationTerritory['status'], string> = {
  active: 'Active now',
  upkeep: 'Upkeep',
  waiting: 'Not opened',
};

/**
 * Regions in the order the flow opens them, as one line: done regions filled, the active one marked.
 * `live` means a cycle is running right now: only then do sparks travel the line and the active region
 * breathe. Idle stays still, so motion always means work is happening.
 */
export function RegionPath({
  territories,
  hue = 'teal',
  live = false,
  loop,
}: {
  territories: ActivationTerritory[];
  hue?: Hue;
  live?: boolean;
  /** FW-C-098: the flow's loop state; regions and the lines between them take it and open on click. */
  loop?: Loop;
}) {
  const target = useLoopTarget();
  const ts = [...territories].sort((a, b) => a.order - b.order);
  const n = ts.length;
  const at = ts.findIndex((t) => t.status === 'active');
  const lastDone = ts.reduce((k, t, i) => (t.status === 'upkeep' ? i : k), -1);
  const reach = Math.max(at, lastDone);
  const mid = (i: number) => `${((i + 0.5) / n) * 100}%`;
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  // Sparks run from the start to the region being worked, or toward the next one when it is the first.
  const laneEnd = at < 0 ? -1 : Math.min(Math.max(at, 1), n - 1);
  // A region the flow has reached carries the flow's state; one not opened yet waits.
  const reached = (i: number): Loop =>
    !loop
      ? 'waiting'
      : i <= reach
        ? loop === 'working' && ts[i].status !== 'active'
          ? 'connected'
          : loop
        : 'waiting';
  const nodeInfo = (t: ActivationTerritory, i: number): LoopInfo => ({
    title: t.name,
    loop: reached(i),
    what: `Region ${i + 1} of ${n}. The flow works one region at a time, in this order, and opens the next only with your OK.`,
    why: `${REGION_WORD[t.status]}${t.progress != null ? `, ${pct(t.progress)} of the way to fully active` : ''}.`,
  });
  const linkInfo = (i: number): LoopInfo => ({
    title: `${ts[i].name} to ${ts[i + 1].name}`,
    loop: i + 1 <= reach ? reached(i + 1) : 'waiting',
    what: `The hand-off between two regions. The flow moves on to ${ts[i + 1].name} once ${ts[i].name} is fully active and you say OK.`,
    why: i + 1 <= reach ? 'Already crossed.' : 'Not crossed yet.',
  });
  return (
    <div
      className={`region-path${live ? ' is-live' : ''}${loop ? ' has-loops' : ''}`}
      style={{ '--c': `var(--flow-${hue})` } as CSSProperties}
    >
      <div className="flow-track" aria-hidden={loop ? undefined : true} style={cols}>
        <span className="flow-track-base" style={{ left: mid(0), right: `calc(100% - ${mid(n - 1)})` }} />
        {reach > 0 && (
          <span
            className="flow-track-fill"
            style={{ left: mid(0), width: `calc(${mid(reach)} - ${mid(0)})` }}
          />
        )}
        {live && laneEnd > 0 && (
          <span
            className="flow-travel-lane"
            style={{ left: mid(0), width: `calc(${mid(laneEnd)} - ${mid(0)})` }}
          >
            <span className="flow-travel" />
            <span className="flow-travel" />
            <span className="flow-travel" />
          </span>
        )}
        {loop &&
          ts.slice(0, -1).map((t, i) => (
            <span
              key={`link-${t.id}`}
              {...target(linkInfo(i), 'region-link')}
              style={{ left: mid(i), width: `calc(${mid(i + 1)} - ${mid(i)})` }}
            >
              <span className="loop-line" />
            </span>
          ))}
        {ts.map((t, i) => {
          const cls = `flow-node${t.status === 'active' ? ` is-here${live ? ' is-live' : ''}` : t.status === 'upkeep' ? ' is-passed' : ''}`;
          return loop ? (
            <span key={t.id} {...target(nodeInfo(t, i), cls)} />
          ) : (
            <span key={t.id} className={cls} />
          );
        })}
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

/* --------------------------------------------------------------- FlowPulse */

export type PulseState = 'running' | 'ready' | 'held' | 'unknown';

/**
 * The flow's heartbeat as one chip. Running pulses; ready, held and unknown stay still, so the
 * page's one rule holds: moving means a cycle is working now. The word always says it too.
 */
export function FlowPulse({ state, word }: { state: PulseState; word: string }) {
  return (
    <span className={`flow-pulse is-${state}`}>
      <span className="flow-pulse-dot" aria-hidden="true" />
      {word}
    </span>
  );
}

/* ------------------------------------------------------------ MeasureDials */

/** One dial per activation measure, each against its target. Unknown stays Unknown, never zero. */
export function MeasureDials({
  t,
  measures,
  compact = false,
  loop,
}: {
  t: ActivationTerritory;
  measures: { key: keyof ActivationMeasures; label: string }[];
  /** Small dials, with the value and target in the caption instead of inside the dial. */
  compact?: boolean;
  /** FW-C-098: the region's loop state; each dial glows and flows with it and opens on click. */
  loop?: Loop;
}) {
  const m = t.measures;
  return (
    <ul className={compact ? 'dials is-compact' : 'dials'}>
      {measures.map(({ key, label }) => {
        const target = t.targets[key];
        const v = m ? m[key] : null;
        return (
          <li key={key} className="dial">
            <Gauge
              size={compact ? 64 : 124}
              value={v}
              cap={target}
              label={`${label} in ${t.name}`}
              valueText={v == null ? undefined : `${num(v)} of ${num(target)}`}
              center={v == null ? <span className="dial-unknown">Unknown</span> : compact ? null : num(v)}
              loop={
                loop && {
                  title: `${label} in ${t.name}`,
                  loop,
                  what: `One of the measures that decide when ${t.name} counts as fully active. Its target is ${num(target)}.`,
                  why: v == null ? 'No reading yet.' : `${num(v)} of ${num(target)} so far.`,
                }
              }
              sub={compact ? undefined : `of ${num(target)}`}
            />
            {compact ? (
              <span className="dial-caption">
                <strong>{v == null ? 'Unknown' : num(v)}</strong> of {num(target)}
                <span className="dial-what">{label}</span>
              </span>
            ) : (
              <span className="dial-caption">{label}</span>
            )}
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

/* -------------------------------------------------------------- Drafts (FW-C-066) */

/** The tone class for each draft state word. Saffron (waiting) only for drafts that wait on the Owner. */
export const TONE: Record<DraftState, string> = {
  Ready: 'waiting',
  'Has blanks': 'caution',
  Blocked: 'caution',
  Sent: 'sent',
  Replied: 'replied',
  'Said no': 'quiet',
  Approved: 'approved',
  Rejected: 'quiet',
};

export function StatePill({ s }: { s: DraftState }) {
  return (
    <span className={`draft-state is-${TONE[s]}`}>
      <span className="draft-state-dot" aria-hidden="true" />
      {s}
    </span>
  );
}

/** Drafts written each day for two weeks, as small bars. Still: it shows what happened, not a live process. */
export function DraftBars({ drafts }: { drafts: FlowDraft[] }) {
  const days = draftsPerDay(drafts);
  const max = Math.max(1, ...days);
  const total = days.reduce((a, b) => a + b, 0);
  return (
    <figure className="draft-bars" aria-label={`${total} drafts written in the last 14 days`}>
      <svg viewBox="0 0 140 32" preserveAspectRatio="none" aria-hidden="true">
        {days
          .map((n, i) => ({ n, x: i * 10 + 1, h: n === 0 ? 2 : 4 + (n / max) * 28 }))
          .map((bar) => (
            <rect
              key={`x${bar.x}`}
              className={bar.n === 0 ? 'is-empty' : undefined}
              x={bar.x}
              y={32 - bar.h}
              width="7"
              height={bar.h}
              rx="2"
            />
          ))}
      </svg>
      <figcaption>
        <strong>{total}</strong> written in 14 days
      </figcaption>
    </figure>
  );
}

/** How the sent ones are doing: a soft meter of replies against sends. */
export function ReplyMeter({ drafts }: { drafts: FlowDraft[] }) {
  const sent = drafts.filter((d) => d.sent_at).length;
  const replied = drafts.filter((d) => d.replied_at).length;
  const share = sent ? replied / sent : 0;
  return (
    <div className="reply-meter" role="img" aria-label={`${replied} of ${sent} sent drafts got a reply`}>
      <span className="reply-meter-track" aria-hidden="true">
        <span className="reply-meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="reply-meter-text">
        <Icon name="send" size={13} /> {sent} sent <Icon name="reply" size={13} /> {replied} replied
      </span>
    </div>
  );
}
