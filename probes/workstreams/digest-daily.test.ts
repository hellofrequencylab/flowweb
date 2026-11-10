// Probe for FW-C-061 (the daily digest runs by itself and the Console shows it):
// `pnpm probe workstreams/digest-daily`. Tier 0.
// probe-timeout-s: 180
// Surfaces: the daemon fwd on a fresh FW_HOME after `fw ledger sync` of a fixture project, its HTTP API
// with the CLI token fwd prints, the streams table and the stream.fired and digest.published events of
// schema.core.sql read with node:sqlite read-only, and the web client's `api.dawn()` (what the Console
// renders) with fetch pointed at that fwd.
// The surface this probe expects:
//   For each project with a ledger (a backlog-dev stream), fwd registers one active stream with key
//   "digest" and template "digest", triggered by a daily cron (minute and hour fixed, every day). Each
//   fire publishes that project's digest (publishDigest, FW-C-023) over the period since the last one.
//   When fwd starts and the project has no digest since the newest slot (the machine was off or asleep
//   at that hour, or the stream is new), it fires the stream once at once, so the Console has today's
//   digest without waiting a day. A restart with a digest already in place publishes nothing new.
//   The Console takes a stored daily digest as one that passed its check (publishDigest stores no
//   other kind), so it shows the digest's headline and not "No digest yet" or "failed its own check".
//
// Proves, in order:
//   1. Soon after fwd starts, GET /v1/status-reports?kind=daily answers one digest for the project,
//      and every line in it cites a registered query.
//   2. The project has exactly one digest stream: active, template digest, a daily cron.
//   3. The job ledger records the fire (stream.fired, outcome fired) and digest.published names the report.
//   4. api.dawn() returns that digest with self_check_ok true and its headline.
//   5. After a restart, still one digest stream and one daily digest.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
  DAEMON_BIN,
  fail,
  fixtureProject,
  freshHome,
  fw,
  killAndWait,
  openDbReadonly,
  root,
  sleep,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const CITE = /\[q:([a-z0-9_]+)\]/;
const kids: { exitCode: number | null; output(): string }[] = [];

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

async function startFwd(home: string) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home, FW_VENDOR: 'fake' } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  if (d.exitCode !== null) fail(`fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  if (!tokenPath) fail('fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath!, 'utf8').trim() };
}

async function getJson(port: number, token: string, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
}

type Report = { id: string; project_id: string; kind: string; body: Record<string, any> };

afterAll(async () => {
  for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
});

describe('workstreams/digest-daily', () => {
  test('fwd publishes the daily digest by itself and the Console shows it', async () => {
    const home = freshHome('digest-daily');
    const proj = fixtureProject({ rowId: 'FW-C-967' });
    expect(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status, 'fw ledger sync').toBe(0);

    // ---- 1. a digest appears without anyone asking --------------------------------------------------
    let f = await startFwd(home);
    let reports: Report[] = [];
    try {
      await waitFor(
        async () => {
          reports = (await getJson(f.port, f.token, '/status-reports?kind=daily&limit=50')).body?.data ?? [];
          return reports.length > 0;
        },
        { timeoutMs: 20000, everyMs: 250, what: 'a daily digest' },
      );
    } catch {
      fail('no daily digest was published within 20 s of fwd starting (nothing calls publishDigest)');
    }
    expect(reports.length, 'daily digests after the first start').toBe(1);
    const report = reports[0]!;
    const body = report.body;
    const lines = [body.headline, ...['done', 'next', 'blocked', 'risks'].flatMap((k) => (body[k] ?? []).map((l: { text: string }) => l.text))];
    for (const l of lines) if (!CITE.test(String(l))) fail(`a digest line cites no query: ${l}`);

    // ---- 2. one daily digest stream per project ---------------------------------------------------
    const db = await openDbReadonly(home);
    try {
      const streams = db
        .prepare("SELECT id, project_id, template, status, definition FROM streams WHERE key = 'digest'")
        .all() as { id: string; project_id: string; template: string; status: string; definition: string }[];
      expect(streams.length, 'digest streams').toBe(1);
      const s = streams[0]!;
      expect(s.project_id, 'the digest stream belongs to the synced project').toBe(report.project_id);
      expect(s.template).toBe('digest');
      expect(s.status).toBe('active');
      const trig = JSON.parse(s.definition).trigger;
      expect(trig?.type, 'the digest stream is triggered by cron').toBe('cron');
      const parts = String(trig.cron).trim().split(/\s+/);
      const daily = parts.length === 5 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!) && parts.slice(2).every((p) => p === '*');
      expect(daily, `the digest cron "${trig.cron}" fires once every day`).toBe(true);

      // ---- 3. the fire and the publish are on the record --------------------------------------------
      const fired = db
        .prepare("SELECT payload FROM events WHERE type = 'stream.fired' AND stream_id = ?")
        .all(s.id)
        .map((r: any) => JSON.parse(r.payload));
      expect(fired.some((p: { outcome: string }) => p.outcome === 'fired'), 'a stream.fired event with outcome fired').toBe(true);
      const published = db
        .prepare("SELECT payload FROM events WHERE type = 'digest.published'")
        .all()
        .map((r: any) => JSON.parse(r.payload).digest_id);
      expect(published, 'digest.published names the report').toContain(report.id);
    } finally {
      db.close();
    }

    // ---- 4. the Console reads it as today's digest -------------------------------------------------
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string, init: RequestInit = {}) =>
      realFetch(`http://127.0.0.1:${f.port}${input}`, {
        method: init.method ?? 'GET',
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${f.token}` },
        ...(init.body !== undefined ? { body: init.body } : {}),
      })) as typeof fetch;
    try {
      const { api } = await import(pathToFileURL(join(root, 'packages/web/src/api/client.ts')).href);
      const dawn = await api.dawn();
      expect(dawn.digest, 'the Console has a digest (not "No digest yet")').not.toBeNull();
      expect(dawn.digest.id).toBe(report.id);
      expect(dawn.digest.self_check_ok, 'the Console does not say the digest failed its own check').toBe(true);
      expect(dawn.digest.headline).toBe(body.headline);
    } finally {
      globalThis.fetch = realFetch;
    }

    // ---- 5. a restart does not publish a second digest ------------------------------------------------
    await killAndWait(f.d as any, 'SIGTERM');
    f = await startFwd(home);
    await sleep(3000);
    const again = (await getJson(f.port, f.token, '/status-reports?kind=daily&limit=50')).body?.data ?? [];
    expect(again.length, 'daily digests after a restart').toBe(1);
    const db2 = await openDbReadonly(home);
    try {
      expect((db2.prepare("SELECT count(*) AS n FROM streams WHERE key = 'digest'").get() as { n: number }).n, 'digest streams after a restart').toBe(1);
    } finally {
      db2.close();
    }
  });
});
