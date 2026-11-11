// FW-C-063: when a flow runs each morning, and how many new people it reaches a day. Plain code: the
// Owner sets a time and Every day or Weekdays, which becomes the flow stream's cron, and a number of new
// people a day. With auto on, today's number follows the last 14 days of sent drafts, within the Owner's
// min and max. Nothing here sends anything or changes the dial.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Days = 'daily' | 'weekdays';
export const DAYS: readonly Days[] = ['daily', 'weekdays'];
export const PER_DAY_MAX = 25;

export interface Intensity {
  per_day: number;
  auto: boolean;
  min: number;
  max: number;
}
// FW-C-101: 15 new people a day by default (v2 launch machine), up to 25 with the intensity control.
export const DEFAULT_INTENSITY: Intensity = { per_day: 15, auto: false, min: 3, max: PER_DAY_MAX };

/** Sent drafts before auto judges the results. */
export const AUTO_MIN_SENT = 20;
/** The days of sent drafts auto reads. */
export const AUTO_WINDOW_DAYS = 14;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class IntensityError extends Error {}

/** 'HH:MM' and Every day or Weekdays as a five-field cron. Throws on anything else. */
export function scheduleCron(time: string, days: string): string {
  const m = TIME.exec(time);
  if (!m) throw new IntensityError(`time must be HH:MM (00:00 to 23:59), not "${time}"`);
  if (!DAYS.includes(days as Days)) throw new IntensityError(`days must be daily or weekdays, not "${days}"`);
  return `${Number(m[2])} ${Number(m[1])} * * ${days === 'daily' ? '*' : '1-5'}`;
}

/** The time and days a simple cron names, or null when it is not one scheduleCron writes. */
export function cronSchedule(cron: string): { time: string; days: Days } | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const hour = Number(m[2]);
  if (min > 59 || hour > 23) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { time: `${pad(hour)}:${pad(min)}`, days: m[3] === '*' ? 'daily' : 'weekdays' };
}

const whole = (v: unknown, name: string, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
    throw new IntensityError(`${name} must be a whole number from ${lo} to ${hi}`);
  return v;
};

/** Checks an intensity body: per_day, min and max 1-25 with min <= per_day <= max, auto a boolean. */
export function parseIntensity(body: Record<string, unknown>): Intensity {
  const per_day = whole(body.per_day, 'per_day', 1, PER_DAY_MAX);
  const min =
    body.min === undefined
      ? Math.min(DEFAULT_INTENSITY.min, per_day)
      : whole(body.min, 'min', 1, PER_DAY_MAX);
  const max = body.max === undefined ? PER_DAY_MAX : whole(body.max, 'max', 1, PER_DAY_MAX);
  if (body.auto !== undefined && typeof body.auto !== 'boolean')
    throw new IntensityError('auto must be true or false');
  if (min > per_day || per_day > max)
    throw new IntensityError('min must be at most per_day, and per_day at most max');
  return { per_day, auto: body.auto === true, min, max };
}

/** A stored intensity, or the default when it is missing or broken. */
export function readIntensity(raw: unknown): Intensity {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_INTENSITY };
  try {
    return parseIntensity(raw as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_INTENSITY };
  }
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Today's number of new people: the Owner's, or with auto on, moved by the last 14 days' results. */
export function effectivePerDay(
  s: Intensity,
  stats: { sent: number; responded: number; declined: number },
): { per_day: number; why: string } {
  if (!s.auto) return { per_day: s.per_day, why: `Set to ${s.per_day} a day.` };
  if (stats.sent < AUTO_MIN_SENT)
    return {
      per_day: s.per_day,
      why: `${stats.sent} of ${AUTO_MIN_SENT} sent in the last ${AUTO_WINDOW_DAYS} days, too few to judge, so ${s.per_day}.`,
    };
  const declined = stats.declined / stats.sent;
  const responded = stats.responded / stats.sent;
  let factor = 1;
  let why: string;
  if (declined >= 0.1) {
    factor = 0.5;
    why = `${pct(declined)} said no in the last ${AUTO_WINDOW_DAYS} days, so half as many`;
  } else if (responded >= 0.08) {
    factor = 1.5;
    why = `${pct(responded)} responded in the last ${AUTO_WINDOW_DAYS} days, so a half more`;
  } else if (responded < 0.02) {
    factor = 0.75;
    why = `${pct(responded)} responded in the last ${AUTO_WINDOW_DAYS} days, so a quarter fewer`;
  } else {
    why = `${pct(responded)} responded in the last ${AUTO_WINDOW_DAYS} days, so no change`;
  }
  const raw = Math.round(s.per_day * factor);
  const per_day = Math.min(s.max, Math.max(s.min, raw));
  if (per_day !== raw) why += `, held at your ${per_day === s.max ? 'max' : 'min'} of ${per_day}`;
  return { per_day, why: `${why}.` };
}

type Doc = Record<string, unknown>;
const isObj = (x: unknown): x is Doc => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (d: Doc, k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
const readJson = (p: string): unknown => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};

/**
 * What the flow's drafts sent in the last 14 days did: sent, responded (a reply, or a lead, member or host
 * from Frequency's outcomes for the draft's tag) and declined. Read from $FW_HOME/flows/<key>/.
 */
export function recentResults(
  fwHome: string,
  key: string,
  now: Date,
): { sent: number; responded: number; declined: number } {
  const base = join(fwHome, 'flows', key);
  const out = { sent: 0, responded: 0, declined: 0 };
  const draftsDir = join(base, 'drafts');
  if (!existsSync(draftsDir)) return out;
  const raw = readJson(join(base, 'outcomes.json'));
  const rows = isObj(raw) && Array.isArray(raw.outcomes) ? raw.outcomes.filter(isObj) : [];
  const won = new Set(
    rows
      .filter((r) =>
        ['leads', 'members', 'hosts'].some((k) => typeof r[k] === 'number' && (r[k] as number) > 0),
      )
      .map((r) => str(r, 'content'))
      .filter((c): c is string => c !== null),
  );
  const since = now.getTime() - AUTO_WINDOW_DAYS * 86_400_000;
  for (const f of readdirSync(draftsDir)) {
    if (!f.endsWith('.json')) continue;
    const d = readJson(join(draftsDir, f));
    if (!isObj(d)) continue;
    const at = str(d, 'sent_at') ?? str(d, 'replied_at') ?? str(d, 'declined_at');
    if (!at || Date.parse(at) < since) continue;
    out.sent++;
    if (str(d, 'declined_at')) out.declined++;
    const tag = str(d, 'tag');
    if (str(d, 'replied_at') || (tag && won.has(tag))) out.responded++;
  }
  return out;
}
