import { arcPath } from './flow';
import { LOOP_WORD, type Loop, type LoopInfo, useLoopTarget } from './loop';

/**
 * FW-C-099: one process of a flow drawn as a ring inside the flow's outer ring. A process has stages
 * (nodes) joined by lines, or is a meter (spend against its cap). Every node, line and meter takes a
 * loop state and opens what it is on click.
 */
export interface OrbitProcess {
  key: string;
  /** The ring as a whole, for the legend. */
  info: LoopInfo;
  /** One line under the name in the legend. */
  summary: string;
  nodes?: LoopInfo[];
  /** The line from each node to the next; the last one closes the ring. */
  links?: LoopInfo[];
  /** A meter ring fills to this share of its cap (0 to 1). */
  meter?: number;
}

/** Radii for up to three inner rings, inside FlowRing's outer ring at 38. */
export const ORBIT_R = [29, 20.5, 12] as const;

const rad = (a: number) => (a * Math.PI) / 180;

/** The inner rings and the hub, drawn into FlowRing's 100 by 100 box. */
export function OrbitRings({ rings, hub }: { rings: OrbitProcess[]; hub?: LoopInfo }) {
  const target = useLoopTarget();
  return (
    <g className="orbit-rings">
      {rings.slice(0, ORBIT_R.length).map((p, k) => {
        const R = ORBIT_R[k];
        const nodes = p.nodes ?? [];
        const n = nodes.length;
        // Each ring starts a little further round, so nodes on different rings do not line up.
        const a = (i: number) => -90 + 22 * (k + 1) + (360 / Math.max(n, 1)) * i;
        const gap = (5 / R) * (180 / Math.PI);
        return (
          <g key={p.key} className={`orbit-ring orbit-${p.key}`}>
            <circle className="orbit-track" cx="50" cy="50" r={R} />
            {p.meter != null && (
              <g {...target(p.info, 'orbit-meter')}>
                <circle className="loop-hit" cx="50" cy="50" r={R} />
                {p.meter > 0 && (
                  <path
                    className="loop-line"
                    d={arcPath(-90, -90 + Math.min(359.5, 360 * Math.min(1, p.meter)), R)}
                    pathLength="100"
                  />
                )}
              </g>
            )}
            {n > 1 &&
              (p.links ?? []).slice(0, n).map((l, i) => {
                const d = arcPath(a(i) + gap, a(i + 1) - gap, R);
                return (
                  <g key={`${p.key}-l${l.title}`} {...target(l, 'orbit-link')}>
                    <path className="loop-hit" d={d} />
                    <path className="loop-line" d={d} pathLength="100" />
                  </g>
                );
              })}
            {nodes.map((info, i) => {
              const x = 50 + R * Math.cos(rad(a(i)));
              const y = 50 + R * Math.sin(rad(a(i)));
              return (
                <g key={`${p.key}-n${info.title}`} {...target(info, 'orbit-node')}>
                  <circle className="loop-hit" cx={x} cy={y} r={4.4} />
                  <circle className="orbit-dot" cx={x} cy={y} r={2.4} />
                </g>
              );
            })}
          </g>
        );
      })}
      {hub && (
        <g {...target(hub, 'orbit-hub')}>
          <circle className="orbit-hub-glow" cx="50" cy="50" r="6.5" />
          <circle className="orbit-hub-core" cx="50" cy="50" r="4" />
        </g>
      )}
    </g>
  );
}

/** The rings by name, outer first: each opens what it is, with its state in words. */
export function OrbitLegend({ rings }: { rings: OrbitProcess[] }) {
  const target = useLoopTarget();
  return (
    <ol className="orbit-legend" aria-label="Processes in this flow, outer ring first">
      {rings.map((p, k) => (
        <li key={p.key}>
          <span {...target(p.info, 'orbit-key')}>
            <span className="orbit-key-ring" aria-hidden="true" data-ring={k} />
            <span className="orbit-key-text">
              <span className="orbit-key-name">
                {p.info.title}
                <span className="orbit-key-state">{LOOP_WORD[p.info.loop]}</span>
              </span>
              <span className="orbit-key-sum">{p.summary}</span>
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The weaker of two states, for a line between two nodes. */
export function between(a: Loop, b: Loop): Loop {
  for (const s of ['broken', 'waiting', 'connected', 'working'] as const) if (a === s || b === s) return s;
  return a;
}
