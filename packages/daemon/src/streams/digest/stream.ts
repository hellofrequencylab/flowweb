// The daily digest as a stream (FW-C-059). Each project with a ledger gets one active stream, key digest,
// on a daily cron. The scheduler fires it like any other stream (so every fire is on the job ledger), and
// each admitted fire publishes the project's digest over the period since its last one. When fwd starts
// and a project has no digest since the newest slot (the machine was off or asleep at that hour, or the
// stream is new), fwd fires it once at once, so the Console has today's digest without waiting a day.

import { newId, nowIso, type Reader, type Writer } from '@fw/eventlog';
import { addStream, BACKLOG_STREAM_KEY } from '@fw/ledger';
import { parseCron } from '../../scheduler/cron.ts';
import { type PublishResult, publishDigest } from './digest.ts';

export const DIGEST_STREAM_KEY = 'digest';
/** 06:00 every day, in the machine's time zone: the Owner reads it with the morning coffee. */
export const DIGEST_CRON = '0 6 * * *';
const DAY_MS = 86_400_000;

interface DigestStream {
  id: string;
  project_id: string;
  definition: string;
}

function definition(id: string, projectId: string, timezone: string) {
  return {
    id,
    key: DIGEST_STREAM_KEY,
    name: 'Daily digest',
    project_id: projectId,
    version: 1,
    template: 'digest',
    enabled: true,
    trigger: { type: 'cron', cron: DIGEST_CRON, timezone, catch_up: 'run_once' },
    inputs: [
      { name: 'registered_queries', kind: 'query', ref: `query://${projectId}/digest`, untrusted: false },
    ],
    tools: [],
    action_classes: ['read_research'],
    output: { artifacts: ['status_report'], result_schema: 'status-report.json' },
    verifier: { agent_profile: 'digest-recompute', vendor_policy: 'any', read_only: true },
    human_gate: { min_tier: 'L3', approver: 'owner' },
    default_tier: 'L0',
    // The digest runs no vendor: it reads registered queries only, so it spends nothing.
    budget: { caps: { max_usd: 0 }, period: 'day' },
    wip_limit: 1,
    metrics: ['digest_published'],
  };
}

/** Adds the digest stream to every project with a ledger that has none yet. Returns the ids added. */
export function registerDigestStreams(
  w: Writer,
  opts: { timezone?: string; log?: (line: string) => void } = {},
): string[] {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const projects = w.all<{ project_id: string }>(
    `SELECT DISTINCT s.project_id FROM streams s WHERE s.key = ?
       AND NOT EXISTS (SELECT 1 FROM streams d WHERE d.project_id = s.project_id AND d.key = ?)`,
    [BACKLOG_STREAM_KEY, DIGEST_STREAM_KEY],
  );
  const added: string[] = [];
  for (const { project_id } of projects) {
    try {
      added.push(addStream(w, definition(newId('stm'), project_id, tz)).stream.id);
    } catch (e) {
      opts.log?.(`digest: could not register the digest stream of ${project_id}: ${(e as Error).message}`);
    }
  }
  return added;
}

export function digestStreams(r: Reader): DigestStream[] {
  return r.all<DigestStream>(
    "SELECT id, project_id, definition FROM streams WHERE key = ? AND status = 'active' ORDER BY id",
    [DIGEST_STREAM_KEY],
  );
}

/** The end of the project's newest daily digest, or undefined when it has none. */
function lastDigestEnd(r: Reader, projectId: string): string | undefined {
  return (
    r.get<{ to: string }>(
      'SELECT max(period_to) AS "to" FROM status_reports WHERE kind = \'daily\' AND project_id = ?',
      [projectId],
    )?.to ?? undefined
  );
}

/** The newest cron slot at or before nowMs, or undefined when the stream's cron is not usable. */
function newestSlot(s: DigestStream, nowMs: number): number | undefined {
  try {
    const trig = (JSON.parse(s.definition) as { trigger?: { cron?: string; timezone?: string } }).trigger;
    const cron = parseCron(trig?.cron ?? DIGEST_CRON, trig?.timezone ?? 'UTC');
    let slot: number | undefined;
    for (let t = cron.next(nowMs - 2 * DAY_MS); t !== undefined && t <= nowMs; t = cron.next(t)) slot = t;
    return slot;
  } catch {
    return undefined;
  }
}

/** True when the project has no digest that reaches its stream's newest slot. */
export function digestDue(r: Reader, s: DigestStream, nowMs = Date.now()): boolean {
  const slot = newestSlot(s, nowMs);
  if (slot === undefined) return false;
  const end = lastDigestEnd(r, s.project_id);
  return !end || Date.parse(end) < slot;
}

/** Publishes the digest for one fire of a digest stream: the period since the project's last digest. */
export function publishForStream(w: Writer, streamId: string, at = nowIso()): PublishResult | undefined {
  const s = w.get<{ project_id: string }>('SELECT project_id FROM streams WHERE id = ? AND key = ?', [
    streamId,
    DIGEST_STREAM_KEY,
  ]);
  if (!s) return undefined;
  const last = lastDigestEnd(w, s.project_id);
  const from = last && last < at ? last : new Date(Date.parse(at) - DAY_MS).toISOString();
  return publishDigest(w, { project: s.project_id, from, to: at });
}
