// Five-field cron expressions (minute hour day-of-month month day-of-week) evaluated in an IANA time
// zone, with no dependency. Supports `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, and lists.
// Day of week is 0-7 (0 and 7 are Sunday). When both day fields are restricted, a day matches either
// (the classic cron rule). Wall-clock times that do not exist in the zone (a spring-forward gap) are
// skipped; a repeated hour (fall back) fires once.

export class CronError extends Error {
  override name = 'CronError';
}

export interface Cron {
  readonly expr: string;
  readonly timezone: string;
  /** The first slot strictly after afterMs (epoch ms), or undefined when none within 5 years. */
  next(afterMs: number): number | undefined;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function field(text: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`cron ${name} field "${text}" is not valid`);
    const from = m[1] === '*' ? lo : Number(m[2]);
    const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < lo || to > hi || from > to || step < 1)
      throw new CronError(`cron ${name} field "${text}" is out of range ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Wall-clock time in the zone, as epoch ms of the same fields read as UTC. */
function wallOf(fmt: Intl.DateTimeFormat | undefined, t: number): number {
  if (!fmt) return t;
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute));
}

/** The instant whose wall clock is `wall`, or undefined when that wall time does not exist. */
function instantOf(fmt: Intl.DateTimeFormat | undefined, wall: number): number | undefined {
  if (!fmt) return wall;
  let t = wall - (wallOf(fmt, wall) - wall);
  t = wall - (wallOf(fmt, t) - t);
  return wallOf(fmt, t) === wall ? t : undefined;
}

export function parseCron(expr: string, timezone = 'UTC'): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new CronError(`cron "${expr}" needs 5 fields (minute hour day month weekday)`);
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  const [mins, hours, doms, months, dows] = parts.map((p, i) => field(p, RANGES[i]!, names[i]!)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (dows.has(7)) dows.add(0);
  const domStar = parts[2]!.startsWith('*');
  const dowStar = parts[4]!.startsWith('*');
  let fmt: Intl.DateTimeFormat | undefined;
  if (timezone !== 'UTC') {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      });
    } catch {
      throw new CronError(`time zone "${timezone}" is not known`);
    }
  }
  const dayOk = (d: Date): boolean => {
    const dom = doms.has(d.getUTCDate());
    const dow = dows.has(d.getUTCDay());
    if (domStar && dowStar) return true;
    if (domStar) return dow;
    if (dowStar) return dom;
    return dom || dow;
  };
  /** The first matching wall time strictly after wall (both as UTC-read epoch ms). */
  const nextWall = (wall: number, limit: number): number | undefined => {
    let t = Math.floor(wall / MIN) * MIN + MIN;
    while (t < limit) {
      const d = new Date(t);
      if (!months.has(d.getUTCMonth() + 1)) {
        t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      } else if (!dayOk(d)) {
        t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + DAY;
      } else if (!hours.has(d.getUTCHours())) {
        t = Math.floor(t / HOUR) * HOUR + HOUR;
      } else if (!mins.has(d.getUTCMinutes())) {
        t += MIN;
      } else {
        return t;
      }
    }
    return undefined;
  };
  return {
    expr,
    timezone,
    next(afterMs) {
      const limit = afterMs + 5 * 366 * DAY;
      let wall = wallOf(fmt, afterMs);
      for (;;) {
        const w = nextWall(wall, limit);
        if (w === undefined) return undefined;
        const t = instantOf(fmt, w);
        if (t !== undefined && t > afterMs) return t;
        wall = w;
      }
    },
  };
}
