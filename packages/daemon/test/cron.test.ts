// WS-P1-004: five-field cron expressions evaluated in a time zone (the scheduler's next-fire math).
import { describe, expect, test } from 'vitest';
import { CronError, parseCron } from '../src/scheduler/cron.ts';

const at = (s: string) => Date.parse(s);
const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());

/** The first n slots after start. */
function slots(expr: string, start: string, n: number, tz = 'UTC'): (string | undefined)[] {
  const c = parseCron(expr, tz);
  const out: (string | undefined)[] = [];
  let t: number | undefined = at(start);
  for (let i = 0; i < n && t !== undefined; i++) {
    t = c.next(t);
    out.push(iso(t));
  }
  return out;
}

describe('parseCron', () => {
  test('steps, ranges and lists; the next slot is strictly after the given time', () => {
    expect(slots('*/15 * * * *', '2026-01-05T10:00:00.000Z', 3)).toEqual([
      '2026-01-05T10:15:00.000Z',
      '2026-01-05T10:30:00.000Z',
      '2026-01-05T10:45:00.000Z',
    ]);
    expect(slots('0,30 9-10 * * *', '2026-01-05T10:30:00.000Z', 3)).toEqual([
      '2026-01-06T09:00:00.000Z',
      '2026-01-06T09:30:00.000Z',
      '2026-01-06T10:00:00.000Z',
    ]);
    expect(slots('5 0 * * *', '2026-01-05T00:05:30.000Z', 1)).toEqual(['2026-01-06T00:05:00.000Z']);
  });

  test('day of week (7 is Sunday), month, and the either-day rule when both day fields are set', () => {
    // 2026-01-05 is a Monday.
    expect(slots('0 8 * * 1-5', '2026-01-09T09:00:00.000Z', 1)).toEqual(['2026-01-12T08:00:00.000Z']);
    expect(slots('0 0 * * 7', '2026-01-05T00:00:00.000Z', 1)).toEqual(['2026-01-11T00:00:00.000Z']);
    expect(slots('0 0 1 3 *', '2026-01-05T00:00:00.000Z', 1)).toEqual(['2026-03-01T00:00:00.000Z']);
    expect(slots('0 0 13 * 5', '2026-01-05T00:00:00.000Z', 2)).toEqual([
      '2026-01-09T00:00:00.000Z',
      '2026-01-13T00:00:00.000Z',
    ]);
    expect(slots('0 0 29 2 *', '2026-03-01T00:00:00.000Z', 1)).toEqual(['2028-02-29T00:00:00.000Z']);
  });

  test('evaluates in the stream time zone, skips a spring-forward gap and fires once in a repeated hour', () => {
    expect(slots('0 9 * * *', '2026-01-05T00:00:00.000Z', 1, 'America/New_York')).toEqual([
      '2026-01-05T14:00:00.000Z',
    ]);
    expect(slots('0 9 * * *', '2026-07-05T00:00:00.000Z', 1, 'America/New_York')).toEqual([
      '2026-07-05T13:00:00.000Z',
    ]);
    // From 07:00 on 03-07: 02:30 on 03-08 does not exist in New York; 01:30 on 11-01 happens twice.
    expect(slots('30 2 * * *', '2026-03-07T12:00:00.000Z', 2, 'America/New_York')).toEqual([
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
    expect(slots('30 1 * * *', '2026-10-31T12:00:00.000Z', 2, 'America/New_York')).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });

  test('refuses malformed expressions and unknown zones; a slot that never comes is undefined', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
    expect(() => parseCron('* * * * *', 'Mars/Olympus')).toThrow(CronError);
    expect(parseCron('0 0 31 2 *').next(at('2026-01-01T00:00:00.000Z'))).toBeUndefined();
  });
});
