// GET /v1/status: the status strip. Every figure comes from a table or the event log; a figure
// C0 cannot know is null, never a guess.
import type { Reader } from '@fw/eventlog';

export interface ChainStatus {
  ok: boolean | null;
  head_seq: number | null;
  head_hash: string | null;
  verified_at: string | null;
  failed_seq: number | null;
}

export interface StatusDeps {
  reader: Reader;
  version: string;
  startedAt: string;
  chain: () => ChainStatus;
}

type Json = Record<string, unknown>;

function parse(text: string | undefined | null): Json | undefined {
  if (text === undefined || text === null) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function killStatus(reader: Reader): Json {
  const setting = parse(
    reader.get<{ value: string }>("SELECT value FROM settings WHERE key = 'kill_switch'")?.value,
  );
  if (setting === undefined) {
    return {
      engaged: null,
      engaged_at: null,
      reason: null,
      runs_to_halt: null,
      runs_halted: null,
      keys_revoked: null,
    };
  }
  const engaged = setting.engaged === true;
  // Details recorded by whoever engaged it: the setting first, else the engage event.
  const ev = engaged
    ? parse(
        reader.get<{ payload: string }>(
          "SELECT payload FROM events WHERE type = 'system.kill_switch_engaged' ORDER BY seq DESC LIMIT 1",
        )?.payload,
      )
    : undefined;
  const evTs = engaged
    ? (reader.get<{ ts: string }>(
        "SELECT ts FROM events WHERE type = 'system.kill_switch_engaged' ORDER BY seq DESC LIMIT 1",
      )?.ts ?? null)
    : null;
  const pick = (k: string, evKey = k) => num(setting[k]) ?? num(ev?.[evKey]);
  return {
    engaged,
    engaged_at: engaged ? (str(setting.engaged_at) ?? evTs) : null,
    reason: engaged ? (str(setting.reason) ?? str(ev?.reason)) : null,
    runs_to_halt: engaged ? pick('runs_to_halt') : null,
    runs_halted: engaged ? pick('runs_halted') : null,
    keys_revoked: engaged ? pick('keys_revoked', 'credentials_revoked') : null,
  };
}

function startOfUtcDay(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function spendStatus(reader: Reader): Json {
  const since = startOfUtcDay();
  const today =
    reader.get<{ usd: number }>('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend_entries WHERE ts >= ?', [
      since,
    ])?.usd ?? 0;
  const cap = reader.get<{ max_usd: number | null }>(
    "SELECT max_usd FROM budgets WHERE scope_kind = 'fleet' AND period = 'day' AND max_usd IS NOT NULL",
  );
  const vendors = reader
    .all<{ vendor: string }>(
      'SELECT DISTINCT vendor FROM spend_entries WHERE ts >= ? AND vendor IS NOT NULL ORDER BY vendor',
      [since],
    )
    .map((r) => r.vendor);
  return {
    today_usd: Math.round(today * 1e6) / 1e6,
    daily_cap_usd: cap?.max_usd ?? null,
    vendors_reporting: vendors,
  };
}

/** Tripped when the latest breaker.tripped event has no later breaker.reset. */
function breakerStatus(reader: Reader): Json {
  const trip = reader.get<{ seq: number; payload: string }>(
    "SELECT seq, payload FROM events WHERE type = 'breaker.tripped' ORDER BY seq DESC LIMIT 1",
  );
  if (!trip) return { tripped: false, reason: null };
  const reset = reader.get<{ seq: number }>(
    "SELECT seq FROM events WHERE type = 'breaker.reset' AND seq > ? ORDER BY seq DESC LIMIT 1",
    [trip.seq],
  );
  if (reset) return { tripped: false, reason: null };
  const p = parse(trip.payload) ?? {};
  const reason = [p.scope, p.signal].filter((x) => typeof x === 'string').join(': ');
  return { tripped: true, reason: reason || null };
}

/** True when some non-run budget is exhausted: the admission trigger would refuse a dispatch. */
function pausedByBudget(reader: Reader): boolean {
  return (
    reader.get(
      "SELECT 1 FROM budget_usage WHERE max_usd IS NOT NULL AND spent_usd >= max_usd AND period <> 'run' LIMIT 1",
    ) !== undefined
  );
}

/** The sandbox level recorded for the most recent run that recorded one, else null. */
function lastSandboxLevel(reader: Reader): string | null {
  const ev = reader.get<{ level: string | null }>(
    `SELECT COALESCE(json_extract(payload, '$.sandbox_level'), json_extract(payload, '$.sandbox.level')) AS level
       FROM events WHERE type = 'run.started'
        AND COALESCE(json_extract(payload, '$.sandbox_level'), json_extract(payload, '$.sandbox.level')) IS NOT NULL
      ORDER BY seq DESC LIMIT 1`,
  );
  return ev?.level ?? null;
}

export function statusOf(deps: StatusDeps): Json {
  const { reader } = deps;
  const count = (sql: string) => reader.get<{ n: number }>(sql)?.n ?? 0;
  return {
    daemon: 'up',
    version: deps.version,
    started_at: deps.startedAt,
    kill: killStatus(reader),
    chain: deps.chain(),
    spend: spendStatus(reader),
    breaker: breakerStatus(reader),
    paused_by_budget: pausedByBudget(reader),
    sandbox_level: lastSandboxLevel(reader),
    open_cards: count("SELECT COUNT(*) AS n FROM decision_cards WHERE status = 'open'"),
    running_runs: count("SELECT COUNT(*) AS n FROM runs WHERE status IN ('starting','running','validating')"),
  };
}
