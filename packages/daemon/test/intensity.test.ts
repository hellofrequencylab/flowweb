// FW-C-063: the morning run time and how many new people a flow reaches a day.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  readSettings,
  SupervisorError,
  setDial,
  setFlowEnabled,
  setIntensity,
  setSchedule,
  supervisorView,
} from '../src/overseer/index.ts';
import {
  cronSchedule,
  effectivePerDay,
  parseIntensity,
  recentResults,
  scheduleCron,
} from '../src/overseer/intensity.ts';
import { tempHome, withWriter } from './api-fixtures.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const KEY = 'neighborhood-activation';

describe('schedule', () => {
  test('a time and days round-trip through the cron', () => {
    expect(scheduleCron('06:05', 'daily')).toBe('5 6 * * *');
    expect(cronSchedule('5 6 * * *')).toEqual({ time: '06:05', days: 'daily' });
    expect(cronSchedule('0 7 * * 1-5')).toEqual({ time: '07:00', days: 'weekdays' });
    expect(cronSchedule('*/5 * * * *')).toBeNull();
  });
});

describe('intensity', () => {
  test('bad bodies are refused', () => {
    expect(() => parseIntensity({ per_day: 1.5 })).toThrow();
    expect(() => parseIntensity({ per_day: 5, auto: 'yes' })).toThrow();
    expect(() => parseIntensity({ per_day: 5, min: 6 })).toThrow();
    expect(parseIntensity({ per_day: 5 })).toEqual({ per_day: 5, auto: false, min: 3, max: 25 });
  });

  test('auto says why, including when it is held at a bound', () => {
    const out = effectivePerDay(
      { per_day: 10, auto: true, min: 4, max: 12 },
      { sent: 30, responded: 6, declined: 0 },
    );
    expect(out.per_day).toBe(12);
    expect(out.why).toMatch(/20% responded.*held at your max of 12/);
  });

  test('recent results read only the last 14 days of sent drafts and tagged outcomes', () => {
    const home = tempHome();
    try {
      const dir = join(home.path, 'flows', KEY);
      mkdirSync(join(dir, 'drafts'), { recursive: true });
      const now = new Date('2026-11-20T12:00:00Z');
      const draft = (id: string, d: Record<string, unknown>) =>
        writeFileSync(join(dir, 'drafts', `${id}.json`), JSON.stringify(d));
      draft('a', { sent_at: '2026-11-19T10:00:00Z', replied_at: '2026-11-19T12:00:00Z' });
      draft('b', { sent_at: '2026-11-18T10:00:00Z', declined_at: '2026-11-18T11:00:00Z' });
      draft('c', { sent_at: '2026-11-17T10:00:00Z', tag: 'd_c' });
      draft('d', { sent_at: '2026-10-01T10:00:00Z', replied_at: '2026-10-02T10:00:00Z' });
      draft('e', {});
      writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ outcomes: [{ content: 'd_c', members: 1 }] }));
      expect(recentResults(home.path, KEY, now)).toEqual({ sent: 3, responded: 2, declined: 1 });
    } finally {
      home.cleanup();
    }
  });
});

describe('Owner controls', () => {
  test('a schedule moves the stream cron once, and survives the dial and the switch', () => {
    const home = tempHome();
    try {
      withWriter(home.path, (w) => {
        setFlowEnabled(w, repoRoot, KEY, true);
        const before = w.get<{ version: number }>('SELECT version FROM streams WHERE key = ?', [KEY])!;
        expect(setSchedule(w, repoRoot, KEY, '05:45', 'daily')).toEqual({ changed: true, rescheduled: true });
        expect(setSchedule(w, repoRoot, KEY, '05:45', 'daily')).toEqual({ changed: false, rescheduled: false });
        const row = w.get<{ version: number; definition: string }>(
          'SELECT version, definition FROM streams WHERE key = ?',
          [KEY],
        )!;
        expect(row.version).toBe(before.version + 1);
        expect(JSON.parse(row.definition).trigger.cron).toBe('45 5 * * *');
        expect(w.all("SELECT 1 FROM events WHERE type = 'stream.updated'").length).toBe(1);
        setIntensity(w, repoRoot, KEY, { per_day: 7, auto: true, min: 2, max: 9 });
        setDial(w, repoRoot, home.path, KEY, 'copilot');
        setFlowEnabled(w, repoRoot, KEY, false);
        const s = readSettings(w).flows[KEY]!;
        expect(s.schedule).toEqual({ time: '05:45', days: 'daily' });
        expect(s.intensity).toEqual({ per_day: 7, auto: true, min: 2, max: 9 });
        const v = supervisorView({ reader: w, repoRoot, fwHome: home.path }).flows.find((f) => f.key === KEY)!;
        expect(v.schedule).toEqual(expect.objectContaining({ time: '05:45', days: 'daily', cron: '45 5 * * *' }));
        expect(v.intensity.today.per_day).toBe(7);
      });
    } finally {
      home.cleanup();
    }
  });

  test('a schedule set before the flow is on is applied when it is turned on', () => {
    const home = tempHome();
    try {
      withWriter(home.path, (w) => {
        expect(setSchedule(w, repoRoot, KEY, '06:30', 'weekdays').rescheduled).toBe(false);
        setFlowEnabled(w, repoRoot, KEY, true);
        const def = w.get<{ definition: string }>('SELECT definition FROM streams WHERE key = ?', [KEY])!;
        expect(JSON.parse(def.definition).trigger.cron).toBe('30 6 * * 1-5');
        expect(() => setSchedule(w, repoRoot, KEY, '24:00', 'daily')).toThrow(SupervisorError);
        expect(() => setIntensity(w, repoRoot, 'nope', { per_day: 3 })).toThrow(SupervisorError);
      });
    } finally {
      home.cleanup();
    }
  });
});
