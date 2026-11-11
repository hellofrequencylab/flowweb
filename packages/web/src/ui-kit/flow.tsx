import type { CSSProperties, ReactNode } from 'react';
import type { RowStatus } from '../api/types';
import { Link } from '../shell/router';
import { Icon, type IconName } from './Icon';
import { type LoopInfo, useLoopTarget } from './loop';

/**
 * Flow visuals from the FlowWeb design system (components/flow, data/Meter):
 * the loop every change follows, drawn as a ring or a line, plus the gauges
 * and charts the dashboards use. Colour never carries meaning alone: every
 * visual has a word next to it or an accessible label.
 */

/** The loop every ledger row follows in FlowWeb Core. */
export const STAGES = ['Queued', 'Build', 'Check', 'Sign-off', 'Landed'] as const;

export type FlowState = 'quiet' | 'running' | 'waiting' | 'problem' | 'paused' | 'held' | 'done' | 'unknown';
/** 'accent' is the Owner's picked accent (FW-C-099); the rest are fixed group colours. */
export type Hue = 'slate' | 'teal' | 'clay' | 'indigo' | 'olive' | 'mauve' | 'accent';
const HUES: Hue[] = ['slate', 'teal', 'clay', 'indigo', 'olive', 'mauve'];

/** The nth group colour, for short lists where hashing could repeat a colour. */
export const hueAt = (i: number): Hue => HUES[i % HUES.length];

/** A stable hue for a lane, project or vendor name. Never saffron, green or red. */
export function hueFor(key: string): Hue {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function initials(name: string) {
  const w = name.split(/[\s_-]+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : name.slice(0, 2)).toUpperCase();
}

export interface RowFlow {
  at: number;
  state: FlowState;
  word: string;
}

/** Where a row sits on the loop, from its ledger status. */
export function rowFlow(status: RowStatus): RowFlow {
  switch (status) {
    case 'open':
      return { at: 0, state: 'quiet', word: 'Open' };
    case 'ready':
      return { at: 0, state: 'held', word: 'Ready' };
    case 'parked':
      return { at: 0, state: 'paused', word: 'Parked' };
    case 'claimed':
      return { at: 1, state: 'held', word: 'Claimed' };
    case 'running':
      return { at: 1, state: 'running', word: 'Building' };
    case 'blocked':
      return { at: 1, state: 'problem', word: 'Blocked' };
    case 'verifying':
      return { at: 2, state: 'running', word: 'Checking' };
    case 'awaiting_approval':
      return { at: 3, state: 'waiting', word: 'Needs you' };
    case 'merging':
      return { at: 4, state: 'running', word: 'Merging' };
    case 'watching':
      return { at: 4, state: 'held', word: 'Watching' };
    case 'regressed':
      return { at: 4, state: 'problem', word: 'Regressed' };
    case 'done':
      return { at: 4, state: 'done', word: 'Landed' };
    default:
      return { at: 0, state: 'unknown', word: 'Unknown' };
  }
}

export const STATE_ICON: Record<FlowState, IconName> = {
  running: 'running',
  waiting: 'waiting',
  problem: 'problem',
  quiet: 'moon',
  unknown: 'unknown',
  paused: 'paused',
  held: 'dot',
  done: 'done',
};
const STATE_CLASS: Record<FlowState, string> = {
  running: 'fs-running',
  waiting: 'fs-waiting',
  problem: 'fs-problem',
  quiet: 'fs-quiet',
  unknown: 'fs-unknown',
  paused: 'fs-paused',
  held: 'fs-held',
  done: 'fs-done',
};

const quietish = (s: FlowState) => s === 'quiet' || s === 'unknown';
const hueVar = (h: Hue) => (h === 'accent' ? 'var(--accent)' : `var(--flow-${h})`);
const ang = (i: number, n: number) => -90 + (360 / n) * i;
const pt = (i: number, n: number, r: number): [number, number] => {
  const a = (ang(i, n) * Math.PI) / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
};

/* ---------------------------------------------------------------- FlowRing */

/** One change drawn as a closed loop: the arc fills to where it is, a saffron gate where it waits on you. */
export function FlowRing({
  hue = 'slate',
  at = 0,
  state = 'quiet',
  size = 120,
  stages = STAGES as readonly string[],
  label,
  sublabel,
  showLabels = false,
  tallies,
  title,
  loops,
  links,
  inner,
}: {
  hue?: Hue;
  at?: number;
  state?: FlowState;
  size?: number;
  stages?: readonly string[];
  label?: ReactNode;
  sublabel?: ReactNode;
  showLabels?: boolean;
  tallies?: number[];
  /** Accessible name. Pass "" when a word beside the ring already says it. */
  title?: string;
  /** FW-C-098: each stage's loop state; the stage's node then shows it and opens what it is on click. */
  loops?: LoopInfo[];
  /** FW-C-098: the line from each stage to the next, as a clickable, stateful connection. */
  links?: LoopInfo[];
  /** FW-C-099: more processes drawn as rings inside this one (OrbitRings), in the same 100 by 100 box. */
  inner?: ReactNode;
}) {
  const target = useLoopTarget();
  const n = stages.length;
  const color = hueVar(hue);
  const quiet = quietish(state);
  const tiny = size < 56;
  const big = size >= 200;
  const R = 38;
  const sw = tiny ? 7 : big ? 3.2 : 4.5;
  const prog = quiet ? 0 : state === 'done' ? 100 : (at / n) * 100;
  const nodeR = tiny ? 0 : big ? 3.2 : 4;
  const name =
    title ??
    `${typeof label === 'string' ? label : 'Change'}: ${quiet ? state : `${state} at ${stages[at]}`}`;
  return (
    <RingBox
      className={`flow-ring ${STATE_CLASS[state]}${loops || links ? ' has-loops' : ''}`}
      name={name}
      interactive={Boolean(loops || links)}
      style={{ width: size, height: size, '--c': color } as CSSProperties}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={quiet ? 'var(--flow-line-quiet)' : `color-mix(in srgb, ${color} 20%, transparent)`}
          strokeWidth={sw}
          strokeDasharray={quiet ? (tiny ? '3 5' : '1.5 4') : undefined}
          strokeLinecap="round"
        />
        {prog > 0 && (
          <circle
            className={state === 'running' ? 'flow-glow' : undefined}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray={`${prog} 100`}
            transform="rotate(-90 50 50)"
          />
        )}
        {tallies &&
          !tiny &&
          stages.map((s, i) => {
            const k = Math.min(tallies[i] ?? 0, 12);
            const a0 = ang(i, n) + 9;
            const a1 = ang(i + 1, n) - 9;
            return Array.from({ length: k }, (_, j) => {
              const a = ((a0 + (k === 1 ? (a1 - a0) / 2 : ((a1 - a0) * j) / (k - 1))) * Math.PI) / 180;
              const r0 = R + 6.5;
              const r1 = R + (j % 5 === 4 ? 11 : 9);
              return (
                <line
                  key={`${s}-${a}`}
                  x1={50 + r0 * Math.cos(a)}
                  y1={50 + r0 * Math.sin(a)}
                  x2={50 + r1 * Math.cos(a)}
                  y2={50 + r1 * Math.sin(a)}
                  stroke={quiet ? 'var(--text-tertiary)' : color}
                  strokeOpacity={quiet ? 0.5 : 0.75}
                  strokeWidth=".9"
                  strokeLinecap="round"
                />
              );
            });
          })}
        {!tiny && inner}
        {links &&
          !tiny &&
          links.map((l, i) => {
            const d = arcPath(ang(i, n) + 7, ang(i + 1, n) - 7, R);
            return (
              <g key={`link-${stages[i]}`} {...target(l, 'loop-link')}>
                <path className="loop-hit" d={d} />
                <path className="loop-line" d={d} pathLength="100" />
              </g>
            );
          })}
        {state === 'running' && (
          <g
            className="fw-motion flow-orbit"
            style={
              {
                '--a0': `${(360 / n) * Math.max(0, at - 1)}deg`,
                '--a1': `${(360 / n) * at}deg`,
              } as CSSProperties
            }
          >
            <circle className="flow-spark" cx="50" cy={50 - R} r={tiny ? 4 : 2.6} />
          </g>
        )}
        {!tiny &&
          stages.map((s, i) => {
            const [x, y] = pt(i, n, R);
            const here = i === at && !quiet && state !== 'done';
            const info = loops?.[i];
            const wrap = (el: ReactNode) =>
              info ? (
                <g key={s} {...target(info, 'loop-node')}>
                  <circle className="loop-hit" cx={x} cy={y} r={9} />
                  {el}
                </g>
              ) : (
                el
              );
            if (here && state === 'waiting') {
              const g = big ? 9 : 12;
              return wrap(
                <rect
                  key={s}
                  className="flow-gate"
                  x={x - g / 2}
                  y={y - g / 2}
                  width={g}
                  height={g}
                  rx={g * 0.3}
                />,
              );
            }
            const fail = here && state === 'problem';
            const lit = (i < at && !quiet) || here || state === 'done';
            return wrap(
              <circle
                key={s}
                cx={x}
                cy={y}
                r={here ? nodeR + 1.2 : nodeR}
                fill={fail ? 'var(--fail-fg)' : lit ? color : 'var(--flow-ground)'}
                stroke={fail ? 'none' : quiet ? 'var(--flow-line-quiet)' : color}
                strokeWidth="1.6"
              />,
            );
          })}
      </svg>
      {tiny && (state === 'waiting' || state === 'problem') && (
        <span className={`flow-ring-corner flow-ring-corner-${state}`} aria-hidden="true" />
      )}
      {!tiny && (label || sublabel) && (
        <div className="flow-ring-center">
          {label && <span className={big ? 'flow-ring-label-big' : 'flow-ring-label'}>{label}</span>}
          {sublabel && <span className="flow-ring-sub">{sublabel}</span>}
        </div>
      )}
      {showLabels &&
        !tiny &&
        stages.map((s, i) => {
          const [x, y] = pt(i, n, R + (tallies ? 19 : 15));
          const here = i === at && !quiet;
          return (
            <span
              key={`l-${s}`}
              className={`flow-ring-stage${here ? ' is-here' : ''}`}
              style={{ left: `${x}%`, top: `${y}%` }}
            >
              {s}
              {tallies && <span className="flow-ring-tally">×{tallies[i] ?? 0}</span>}
            </span>
          );
        })}
    </RingBox>
  );
}

function RingBox({
  name,
  className,
  style,
  children,
  interactive = false,
}: {
  name: string;
  className: string;
  style: CSSProperties;
  children: ReactNode;
  /** Holds clickable parts: a group, so its buttons stay reachable. */
  interactive?: boolean;
}) {
  if (interactive)
    return (
      <fieldset className={className} aria-label={name || undefined} style={style}>
        {children}
      </fieldset>
    );
  return name ? (
    <div className={className} role="img" aria-label={name} style={style}>
      {children}
    </div>
  ) : (
    <div className={className} aria-hidden="true" style={style}>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- FlowOrbit */

export interface OrbitItem {
  key: string;
  at: number;
  state: FlowState;
}

/** A group (a lane, a project) as concentric loops: one ring per change in flight, up to four. */
export function FlowOrbit({
  name,
  hue,
  items,
  extra = 0,
  size = 156,
  to,
}: {
  name: string;
  hue: Hue;
  items: OrbitItem[];
  /** Changes in flight beyond the four drawn. */
  extra?: number;
  size?: number;
  to?: string;
}) {
  const color = hueVar(hue);
  const n = STAGES.length;
  const rings = items.slice(0, 4);
  const count = (s: FlowState) => items.filter((w) => w.state === s).length;
  const waiting = count('waiting');
  const running = count('running');
  const problem = count('problem');
  const parts = [
    running && `${running} running`,
    waiting && `${waiting} need${waiting > 1 ? '' : 's'} you`,
    problem && `${problem} problem${problem > 1 ? 's' : ''}`,
  ].filter(Boolean) as string[];
  const quiet = parts.length === 0;
  const tone = waiting ? 'waiting' : problem ? 'problem' : running ? 'running' : 'quiet';
  const body = (
    <>
      <span
        className="flow-orbit-art"
        style={{ width: size, height: size, '--c': color, '--ws': `var(--ws-${hue})` } as CSSProperties}
      >
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
          <circle cx="50" cy="50" r="49" fill={`color-mix(in srgb, ${color} 7%, transparent)`} />
          {rings.map((w, k) => {
            const R = 44 - k * 8;
            const q = quietish(w.state);
            const prog = q ? 0 : w.state === 'done' ? 100 : (w.at / n) * 100;
            const a = (((360 / n) * w.at - 90) * Math.PI) / 180;
            const hx = 50 + R * Math.cos(a);
            const hy = 50 + R * Math.sin(a);
            return (
              <g key={w.key}>
                <circle
                  cx="50"
                  cy="50"
                  r={R}
                  fill="none"
                  stroke={q ? 'var(--flow-line-quiet)' : `color-mix(in srgb, ${color} 22%, transparent)`}
                  strokeWidth="2.6"
                  strokeDasharray={q ? '1.2 3.4' : undefined}
                  strokeLinecap="round"
                />
                {prog > 0 && (
                  <circle
                    cx="50"
                    cy="50"
                    r={R}
                    fill="none"
                    stroke={color}
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    pathLength="100"
                    strokeDasharray={`${prog} 100`}
                    transform="rotate(-90 50 50)"
                  />
                )}
                {w.state === 'running' && (
                  <g
                    className="fw-motion flow-orbit"
                    style={
                      {
                        '--a0': `${(360 / n) * Math.max(0, w.at - 1)}deg`,
                        '--a1': `${(360 / n) * w.at}deg`,
                        animationDuration: `${2.6 + k * 0.5}s`,
                      } as CSSProperties
                    }
                  >
                    <circle className="flow-spark" cx="50" cy={50 - R} r="2.3" />
                  </g>
                )}
                {w.state === 'waiting' && (
                  <rect className="flow-gate" x={hx - 4.2} y={hy - 4.2} width="8.4" height="8.4" rx="2.6" />
                )}
                {w.state === 'problem' && <circle cx={hx} cy={hy} r="3.6" fill="var(--fail-fg)" />}
                {!q && w.state !== 'waiting' && w.state !== 'problem' && w.state !== 'running' && (
                  <circle cx={hx} cy={hy} r="2.6" fill={color} />
                )}
              </g>
            );
          })}
        </svg>
        <span className={`flow-orbit-badge${quiet ? ' is-quiet' : ''}`} aria-hidden="true">
          {initials(name)}
        </span>
      </span>
      <span className="flow-orbit-name">{name}</span>
      <span className={`flow-orbit-meta fs-${tone}`}>
        <Icon name={STATE_ICON[tone as FlowState]} size={13} />
        {parts.join(' · ') || 'Quiet'}
        {extra > 0 && <span className="muted"> · +{extra} more</span>}
      </span>
    </>
  );
  const label = `${name}: ${parts.join(', ') || 'quiet'}${extra > 0 ? `, ${extra} more in flight` : ''}`;
  return to ? (
    <Link to={to} className="flow-orbit-card" aria-label={label}>
      {body}
    </Link>
  ) : (
    <div className="flow-orbit-card">{body}</div>
  );
}

/* ---------------------------------------------------------------- FlowLine */

/** One change as a line through the five stages. The node shows where it is; a saffron gate means it waits on you. */
export function FlowLine({
  name,
  meta,
  hue,
  at,
  state,
  word,
  when,
  to,
  stack = false,
  stages = STAGES,
}: {
  name: ReactNode;
  meta?: ReactNode;
  hue: Hue;
  at: number;
  state: FlowState;
  word: string;
  when?: ReactNode;
  to?: string;
  stack?: boolean;
  /** Five stage names; the build pipeline's by default. */
  stages?: readonly string[];
}) {
  const color = hueVar(hue);
  const n = stages.length;
  const quiet = quietish(state);
  const done = state === 'done';
  const pct = (i: number) => `${((i + 0.5) / n) * 100}%`;
  const reach = done ? n - 1 : at;
  const track = (
    <div className="flow-track" aria-hidden="true" style={{ '--c': color } as CSSProperties}>
      <span
        className={`flow-track-base${quiet ? ' is-quiet' : ''}`}
        style={{ left: pct(0), right: `calc(100% - ${pct(n - 1)})` }}
      />
      {!quiet && reach > 0 && (
        <span
          className="flow-track-fill"
          style={{ left: pct(0), width: `calc(${pct(reach)} - ${pct(0)})` }}
        />
      )}
      {state === 'running' && at > 0 && (
        <span
          className="flow-travel-lane"
          style={{ left: pct(at - 1), width: `calc(${pct(at)} - ${pct(at - 1)})` }}
        >
          <span className="fw-motion flow-travel" />
        </span>
      )}
      {stages.map((s, i) => {
        const here = i === at && !quiet && !done;
        const passed = i < at || done;
        const cls = here
          ? state === 'waiting'
            ? 'is-gate'
            : state === 'problem'
              ? 'is-fail'
              : `is-here${state === 'running' ? ' is-live' : ''}`
          : passed && !quiet
            ? 'is-passed'
            : '';
        return (
          <span key={s} className={`flow-node ${cls}`}>
            {here && state === 'waiting' && <Icon name="waiting" size={11} />}
            {here && state === 'problem' && <Icon name="x" size={9} />}
          </span>
        );
      })}
    </div>
  );
  const status = (
    <span className={`flow-line-status ${STATE_CLASS[state]}`}>
      <Icon name={STATE_ICON[state]} size={14} />
      {word}
      {!quiet && !done && <span className="muted">· {stages[at]}</span>}
    </span>
  );
  const title = (
    <span className="flow-line-title">
      <FlowRing hue={hue} at={at} state={state} size={22} stages={stages} title="" />
      <span className="flow-line-name">{name}</span>
    </span>
  );
  const inner = (
    <>
      <span className="flow-line-head">
        {title}
        {meta && <span className="flow-line-meta">{meta}</span>}
      </span>
      {track}
      <span className="flow-line-side">
        {status}
        {when && <span className="flow-line-when">{when}</span>}
      </span>
    </>
  );
  const cls = `flow-line${stack ? ' is-stack' : ''}`;
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** The stage names once, above a column of FlowLines. */
export function StageHeader({ stages = STAGES }: { stages?: readonly string[] } = {}) {
  return (
    <div className="flow-stage-head" aria-hidden="true">
      <span />
      <span className="flow-stage-names">
        {stages.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </span>
      <span />
    </div>
  );
}

/* ------------------------------------------------------------ SpreadRibbon */

const fmtN = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);

/** A flowing band whose width follows a count at each step (log scale). null = not reached, left blank. */
export function SpreadRibbon({
  items,
  stages,
  hue = 'slate',
  at,
  height = 56,
  label,
}: {
  items: (number | null)[];
  stages: readonly string[];
  hue?: Hue;
  at?: number;
  height?: number;
  label: string;
}) {
  const color = hueVar(hue);
  const n = stages.length;
  const maxLog = Math.max(1, ...items.filter((v): v is number => v != null).map((v) => Math.log10(v + 1)));
  const half = (v: number | null) => (v == null ? 0 : 1.2 + (Math.log10(v + 1) / maxLog) * (height / 2 - 4));
  const cx = (i: number) => ((i + 0.5) / n) * 100;
  const mid = height / 2;
  const last = items.reduce<number>((a, v, i) => (v != null ? i : a), -1);
  let top = '';
  for (let i = 0; i <= last; i++) {
    const x = cx(i);
    const hw = half(items[i]);
    if (i === 0) {
      top = `M${x} ${mid - hw}`;
      continue;
    }
    const px = cx(i - 1);
    const ph = half(items[i - 1]);
    const k = (x - px) / 2;
    top += ` C${px + k} ${mid - ph} ${x - k} ${mid - hw} ${x} ${mid - hw}`;
  }
  let back = '';
  for (let i = last; i >= 1; i--) {
    const x = cx(i);
    const hw = half(items[i]);
    const px = cx(i - 1);
    const ph = half(items[i - 1]);
    const k = (x - px) / 2;
    back += `${i === last ? ` L${x} ${mid + hw}` : ''} C${x - k} ${mid + hw} ${px + k} ${mid + ph} ${px} ${mid + ph}`;
  }
  const d = last >= 1 ? `${top}${back} Z` : '';
  const id = `sr-${hue}-${label.replace(/\W+/g, '')}`;
  return (
    <div className="spread" role="img" aria-label={label} style={{ '--c': color } as CSSProperties}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={id} x1="0" x2="1">
            <stop offset="0" stopColor={color} stopOpacity=".18" />
            <stop offset="1" stopColor={color} stopOpacity=".42" />
          </linearGradient>
        </defs>
        <line
          x1={cx(0)}
          x2={cx(n - 1)}
          y1={mid}
          y2={mid}
          stroke="var(--flow-line-quiet)"
          strokeWidth="1.5"
          strokeDasharray="2 5"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
        {d && (
          <path
            d={d}
            fill={`url(#${id})`}
            stroke={color}
            strokeOpacity=".55"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div
        className="spread-labels"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0,1fr))` }}
      >
        {stages.map((s, i) => {
          const v = items[i];
          return v == null ? (
            <span key={s} />
          ) : (
            <span key={s} className={`spread-chip${i === at ? ' is-here' : ''}`}>
              {fmtN(v)}
            </span>
          );
        })}
      </div>
      <div
        className="spread-names"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0,1fr))` }}
      >
        {stages.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- TallyMark */

/** Hand-drawn tally in groups of five. Shows how many times something completed. */
export function TallyMark({
  count,
  size = 16,
  maxGroups = 3,
  label,
  hue,
}: {
  count: number;
  size?: number;
  maxGroups?: number;
  label?: string;
  hue?: Hue;
}) {
  const groups = Math.floor(count / 5);
  const rest = count % 5;
  const shown = Math.min(groups, maxGroups);
  const overflow = groups > maxGroups;
  const h = size;
  const gw = size * 0.95;
  const gap = size * 0.38;
  const marks: ReactNode[] = [];
  let x = 0;
  for (let g = 0; g < shown; g++) {
    for (let k = 0; k < 4; k++)
      marks.push(
        <line
          key={`g${g}-${k}`}
          x1={x + (k * gw) / 4.2 + 1}
          y1={2 + (k % 2) * 0.6}
          x2={x + (k * gw) / 4.2 + 0.6}
          y2={h - 2}
        />,
      );
    marks.push(<line key={`s${g}`} x1={x - 1} y1={h * 0.72} x2={x + gw - 1} y2={h * 0.26} />);
    x += gw + gap;
  }
  if (!overflow)
    for (let k = 0; k < rest; k++)
      marks.push(
        <line
          key={`r${k}`}
          x1={x + (k * gw) / 4.2 + 1}
          y1={2 + (k % 2) * 0.6}
          x2={x + (k * gw) / 4.2 + 0.6}
          y2={h - 2}
        />,
      );
  const w = Math.max(1, overflow ? x - gap : x + (rest ? (rest * gw) / 4.2 : 0));
  return (
    <span
      className="tally"
      role="img"
      aria-label={label ?? `${count} time${count === 1 ? '' : 's'}`}
      style={hue ? ({ color: hueVar(hue) } as CSSProperties) : undefined}
    >
      {count > 0 ? (
        <svg width={w + 2} height={h} viewBox={`-1 0 ${w + 2} ${h}`} aria-hidden="true">
          <g stroke="currentColor" strokeWidth={Math.max(1.4, size / 10)} strokeLinecap="round" fill="none">
            {marks}
          </g>
        </svg>
      ) : (
        <span className="tally-none" aria-hidden="true" />
      )}
      <span className="tally-n" aria-hidden="true">
        {count}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------- RunTrace */

export type TraceStatus = 'done' | 'running' | 'waiting' | 'failed' | 'blocked' | 'skipped' | 'pending';
const TRACE: Record<TraceStatus, { icon: IconName; tone: string; word: string }> = {
  done: { icon: 'check', tone: 'ok', word: 'Done' },
  running: { icon: 'running', tone: 'active', word: 'Running' },
  waiting: { icon: 'waiting', tone: 'attention', word: 'Waiting on you' },
  failed: { icon: 'x', tone: 'fail', word: 'Failed' },
  blocked: { icon: 'shield-x', tone: 'warn', word: 'Blocked by a rule' },
  skipped: { icon: 'skipped', tone: 'neutral', word: 'Skipped' },
  pending: { icon: 'notverified', tone: 'neutral', word: 'Not started' },
};

/** One run's steps as a short vertical trace: what happened, when, and what it cost. */
export function RunTrace({
  steps,
}: {
  steps: { key: string; name: ReactNode; status: TraceStatus; detail?: ReactNode; aside?: ReactNode }[];
}) {
  return (
    <ol className="trace">
      {steps.map((s) => {
        const c = TRACE[s.status];
        return (
          <li key={s.key} className={`trace-step trace-${c.tone}`}>
            <span className="trace-rail">
              <span className="trace-dot">
                <Icon name={c.icon} size={12} label={c.word} />
              </span>
            </span>
            <div className="trace-body">
              <span className="trace-name">{s.name}</span>
              {s.detail && <div className="trace-detail">{s.detail}</div>}
            </div>
            {s.aside && <span className="trace-aside">{s.aside}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------- IconTile, Badge */

export type TileTone = 'neutral' | 'brand' | 'waiting' | 'verified' | 'fail' | 'caution' | 'stop';

/** Soft icon mark: a tinted glyph on a faint round wash. */
export function IconTile({
  name,
  tone = 'neutral',
  size = 'md',
  label,
}: {
  name: IconName;
  tone?: TileTone;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}) {
  return (
    <span className={`icon-wash icon-wash-${tone} icon-wash-${size}`}>
      <Icon name={name} size={size === 'sm' ? 15 : size === 'lg' ? 22 : 18} label={label} />
    </span>
  );
}

/** Group identity: initials on a muted hue. Never saffron, green or red. */
export function GroupBadge({
  name,
  hue,
  size = 'md',
}: {
  name: string;
  hue?: Hue;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      className={`group-badge group-badge-${size}`}
      style={{ background: `var(--ws-${hue ?? hueFor(name)})` }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/* ---------------------------------------------------------------- Gauges */

export const arcPath = (a0: number, a1: number, r: number) => {
  const p = (a: number) => [50 + r * Math.cos((a * Math.PI) / 180), 50 + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};

/**
 * A 270° dial against a cap. Neutral harbour blue only: no red for high spend,
 * no reward for saving. A dashed arc shows the forecast; a tick marks the cap.
 */
export function Gauge({
  value,
  cap,
  forecast,
  label,
  valueText,
  center,
  sub,
  size = 200,
  loop,
}: {
  value: number | null;
  cap: number;
  forecast?: number | null;
  label: string;
  /** Spoken value, e.g. "$4.20 of $15.00". */
  valueText?: string;
  center: ReactNode;
  sub?: ReactNode;
  size?: number;
  /** FW-C-098: the loop this meter belongs to: it glows and flows with it and opens what it is on click. */
  loop?: LoopInfo;
}) {
  const target = useLoopTarget();
  const A0 = 135;
  const SPAN = 270;
  const max = Math.max(cap, forecast ?? 0, value ?? 0) * 1.08 || 1;
  const at = (v: number) => A0 + (Math.min(v, max) / max) * SPAN;
  const capA = (at(cap) * Math.PI) / 180;
  const known = value != null;
  const spoken = `${label}: ${known ? (valueText ?? `${value} of ${cap}`) : 'Unknown'}`;
  const t = loop ? target(loop, 'gauge-dial') : { className: 'gauge-dial' };
  const named =
    'role' in t
      ? { ...t, 'aria-label': `${spoken}. ${t['aria-label']}` }
      : { ...t, role: 'img', 'aria-label': spoken };
  return (
    <div className="gauge" style={{ width: size }}>
      <div {...named} style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
          <path className={`gauge-track${known ? '' : ' is-unknown'}`} d={arcPath(A0, A0 + SPAN, 40)} />
          {known && forecast != null && forecast > (value ?? 0) && (
            <path className="gauge-forecast" d={arcPath(at(value ?? 0), at(forecast), 40)} />
          )}
          {known && value > 0 && <path className="gauge-fill" d={arcPath(A0, at(value), 40)} />}
          {loop && <path className="loop-line" d={arcPath(A0, A0 + SPAN, 40)} pathLength="100" />}
          <line
            className="gauge-cap"
            x1={50 + 35 * Math.cos(capA)}
            y1={50 + 35 * Math.sin(capA)}
            x2={50 + 45 * Math.cos(capA)}
            y2={50 + 45 * Math.sin(capA)}
          />
        </svg>
        <span className="gauge-center">
          <span className="gauge-value">{center}</span>
          {sub && <span className="gauge-sub">{sub}</span>}
        </span>
      </div>
    </div>
  );
}

export interface Slice {
  key: string;
  label: string;
  value: number;
  tone: 'ok' | 'fail' | 'stop' | 'active' | 'neutral' | 'warn' | 'unknown' | 'waiting';
  /** A group colour instead of a status tone (projects, vendors). */
  hue?: Hue;
  /** How to print the value, e.g. "$4.20". */
  display?: string;
}

/** Share of a whole as a ring of segments, with the legend beside it carrying the words. */
export function Donut({
  slices,
  center,
  sub,
  size = 132,
  label,
}: {
  slices: Slice[];
  center: ReactNode;
  sub?: ReactNode;
  size?: number;
  label: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  let acc = 0;
  return (
    <div className="donut" role="img" aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle className="donut-track" cx="50" cy="50" r="40" />
        {total > 0 &&
          slices.map((s) => {
            if (s.value <= 0) return null;
            const len = (s.value / total) * 100;
            const gap = slices.filter((x) => x.value > 0).length > 1 ? 1.2 : 0;
            const el = (
              <circle
                key={s.key}
                className={`donut-seg tone-${s.tone}`}
                style={s.hue ? { stroke: hueVar(s.hue) } : undefined}
                cx="50"
                cy="50"
                r="40"
                pathLength="100"
                strokeDasharray={`${Math.max(0, len - gap)} ${100 - Math.max(0, len - gap)}`}
                strokeDashoffset={-acc}
                transform="rotate(-90 50 50)"
              />
            );
            acc += len;
            return el;
          })}
      </svg>
      <span className="donut-center" aria-hidden="true">
        <span className="donut-value">{center}</span>
        {sub && <span className="donut-sub">{sub}</span>}
      </span>
    </div>
  );
}

/** Legend for a Donut or a stacked bar: swatch, word, number. */
export function Legend({ slices, hrefFor }: { slices: Slice[]; hrefFor?: (s: Slice) => string | undefined }) {
  return (
    <ul className="legend">
      {slices.map((s) => {
        const href = hrefFor?.(s);
        const inner = (
          <>
            <span
              className={`legend-swatch tone-${s.tone}`}
              style={s.hue ? { background: hueVar(s.hue) } : undefined}
              aria-hidden="true"
            />
            <span className="legend-label">{s.label}</span>
            <span className="legend-value">{s.display ?? s.value}</span>
          </>
        );
        return <li key={s.key}>{href ? <Link to={href}>{inner}</Link> : inner}</li>;
      })}
    </ul>
  );
}

/** A single horizontal bar split into parts, for shares that read left to right. */
export function ShareBar({ slices, label }: { slices: (Slice & { hue?: Hue })[]; label: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="share-bar" role="img" aria-label={label}>
      {slices.map((s) =>
        s.value > 0 ? (
          <span
            key={s.key}
            className={s.hue ? 'share-seg' : `share-seg tone-${s.tone}`}
            style={{
              width: `${(s.value / total) * 100}%`,
              ...(s.hue ? { background: hueVar(s.hue) } : {}),
            }}
          />
        ) : null,
      )}
    </div>
  );
}
