// FW-C-061: the daily digest stream is registered once per project with a ledger, is due when the
// project has no digest reaching the newest 06:00 slot, and each fire covers the period since the last.
import { ensureBootstrap, ownerActor } from '@fw/ledger';
import { afterEach, expect, test } from 'vitest';
import {
  DIGEST_STREAM_KEY,
  digestDue,
  digestStreams,
  publishForStream,
  registerDigestStreams,
} from '../src/streams/digest/index.ts';
import { tempHome, withWriter } from './api-fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const at = (s: string) => Date.parse(s);

test('one digest stream per project with a ledger, published once per slot', () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  withWriter(h.path, (w) => {
    expect(registerDigestStreams(w, { timezone: 'UTC' })).toEqual([]); // no ledger yet: nothing to report on
    const project = w.transaction((tx) =>
      ensureBootstrap(tx, { slug: 'atlas', name: 'Atlas' } as never, ownerActor(tx), () => new Date()),
    ).projectId;

    const [id] = registerDigestStreams(w, { timezone: 'UTC' });
    expect(registerDigestStreams(w, { timezone: 'UTC' })).toEqual([]);
    const streams = digestStreams(w);
    expect(streams.map((s) => [s.id, s.project_id])).toEqual([[id, project]]);
    const def = JSON.parse(streams[0]!.definition);
    expect(def).toMatchObject({ key: DIGEST_STREAM_KEY, template: 'digest' });
    expect(def.trigger).toEqual({ type: 'cron', cron: '0 6 * * *', timezone: 'UTC', catch_up: 'run_once' });

    // No digest yet: due. The first one covers the day before the fire.
    expect(digestDue(w, streams[0]!, at('2026-11-10T07:00:00Z'))).toBe(true);
    const first = publishForStream(w, id!, '2026-11-10T07:00:00.000Z');
    expect(first?.published).toBe(true);
    const r1 = w.get<{ period_from: string; period_to: string }>(
      'SELECT period_from, period_to FROM status_reports WHERE id = ?',
      [first!.report_id],
    );
    expect(r1).toEqual({ period_from: '2026-11-09T07:00:00.000Z', period_to: '2026-11-10T07:00:00.000Z' });

    // Later the same day: not due. After the next 06:00: due, and the next digest starts where this one ended.
    expect(digestDue(w, streams[0]!, at('2026-11-10T23:00:00Z'))).toBe(false);
    expect(digestDue(w, streams[0]!, at('2026-11-11T06:00:01Z'))).toBe(true);
    const second = publishForStream(w, id!, '2026-11-11T06:00:00.000Z');
    const r2 = w.get<{ period_from: string }>('SELECT period_from FROM status_reports WHERE id = ?', [
      second!.report_id,
    ]);
    expect(r2?.period_from).toBe('2026-11-10T07:00:00.000Z');
  });
});

test('a stream that is not a digest stream publishes nothing', () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  withWriter(h.path, (w) => {
    expect(publishForStream(w, 'stm_notthere1')).toBeUndefined();
  });
});
