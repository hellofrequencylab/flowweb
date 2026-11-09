// Probe executor (WS-P0-019). A command probe runs in its own process group with a scrubbed
// environment and a wall-clock limit; on timeout the whole group gets SIGTERM, then SIGKILL. The
// result keeps the exit code, the duration and the last 4 KB of combined output, redacted.
// Before a row's probe runs, its stored definition is re-hashed and compared with probe_hash (the
// tamper check); a mismatch is refused, recorded as an audit finding, and nothing runs.
import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson, newId, nowIso, redactSecrets, sha256Hex, type Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from './bootstrap.ts';
import type { ProbeDefinition } from './definition.ts';
import { LedgerError } from './errors.ts';
import { transitionRow } from './fsm.ts';
import { gitHead } from './git.ts';
import { codeFromRowId } from './ids.ts';
import { type DbRow, getDbRow } from './rows.ts';

export const OUTPUT_TAIL_BYTES = 4096;
/** Grace between SIGTERM and SIGKILL to the probe's process group. */
export const KILL_GRACE_MS = 1000;

/** Environment variables a probe inherits. Everything else (tokens, keys) is dropped. */
const ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TERM',
  'CI',
];

export type ProbeStatus = 'pass' | 'fail' | 'error';

export interface ProbeRunResult {
  status: ProbeStatus;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  /** Last 4 KB of stdout and stderr interleaved, secrets redacted. */
  output_tail: string;
  /** Set when the probe could not be started. */
  error?: string;
}

export interface ExecuteOptions {
  /** Directory the probe's cwd is resolved against (the repo checkout under test). */
  cwd: string;
  /** Overrides the probe's timeout_s (tests). */
  timeoutMs?: number;
  /** Extra environment entries (never secrets). */
  env?: Record<string, string>;
}

function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, FW_PROBE: '1', ...extra };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

/** Runs a command probe. Never throws for a failing or hanging probe; that is a result. */
export function executeCommandProbe(probe: ProbeDefinition, opts: ExecuteOptions): Promise<ProbeRunResult> {
  if (probe.kind !== 'command' || !probe.command)
    throw new LedgerError('PROBE_UNSUPPORTED', `probe kind ${probe.kind} is not executable in Core yet`);
  const { argv, cwd = '.', timeout_s } = probe.command;
  const base = resolve(opts.cwd);
  const dir = resolve(base, cwd);
  const rel = relative(base, dir);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new LedgerError('BAD_ARGUMENT', `probe cwd ${cwd} leaves the checkout ${base}`);
  const expectedExit = probe.expected.exit_code ?? 0;
  const timeoutMs = opts.timeoutMs ?? timeout_s * 1000;
  const started = performance.now();

  return new Promise((done) => {
    let tail = Buffer.alloc(0);
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
    };
    let timedOut = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: dir,
      env: scrubbedEnv(opts.env),
      detached: true, // own process group, so the whole tree can be killed
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Nothing a probe started may outlive it (and hold the output pipes open).
      killGroup(child.pid, 'SIGKILL');
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const text = redactSecrets(tail.toString('utf8')).value;
      const duration_ms = Math.round(performance.now() - started);
      let status: ProbeStatus;
      if (spawnError !== undefined) status = 'error';
      else if (timedOut) status = 'fail';
      else status = exitCode === expectedExit ? 'pass' : 'fail';
      const result: ProbeRunResult = {
        status,
        exit_code: exitCode,
        signal: exitSignal,
        timed_out: timedOut,
        duration_ms,
        output_tail: text,
      };
      if (spawnError !== undefined) result.error = spawnError;
      done(result);
    });
  });
}

/**
 * Tamper check: re-hashes the stored probe definition and compares it with probe_hash and with the
 * probe columns. On a mismatch, records an audit finding and throws PROBE_TAMPERED.
 */
export function checkedProbe(w: Writer, row: DbRow, actor?: Actor): ProbeDefinition {
  const code = codeFromRowId(row.id);
  let def: ProbeDefinition | undefined;
  try {
    def = JSON.parse(row.probe_spec) as ProbeDefinition;
  } catch {
    def = undefined;
  }
  const computed = def ? sha256Hex(canonicalJson(def)) : 'unparseable';
  const consistent =
    def !== undefined &&
    computed === row.probe_hash &&
    def.kind === row.probe_kind &&
    def.version === row.probe_revision &&
    def.measures === row.probe_measures &&
    def.runs_against === row.probe_runs_against &&
    canonicalJson(def.expected) === canonicalJson(JSON.parse(row.probe_expected));
  if (consistent) return def!;
  const a = actor ?? ownerActor(w);
  const findingId = newId('fnd');
  w.appendEvent({
    type: 'audit.finding_raised',
    actor_kind: a.kind,
    actor_id: a.id,
    project_id: row.project_id,
    idempotency_key: findingId,
    payload: {
      finding_id: findingId,
      check: 'probe_tamper',
      severity: 'high',
      source: 'auditor',
      affected: { project_id: row.project_id },
      breaker_requested: false,
      evidence_refs: [row.id],
      ledger_row_id: row.id,
      stored_hash: row.probe_hash,
      computed_hash: computed,
    },
  });
  throw new LedgerError(
    'PROBE_TAMPERED',
    `tamper_detected: the stored probe of ${code} does not match its probe_hash; refusing to run it`,
    { code, stored_hash: row.probe_hash, computed_hash: computed },
  );
}

export type TargetKind = 'branch' | 'merged' | 'deployed';

export interface RunRowProbeOptions {
  repoDir: string;
  target: TargetKind;
  actor?: Actor;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Re-runs a row's probe against the checkout at repoDir and records it. A failing re-run of a done
 * or watching row moves it to regressed (WS-P0-016).
 */
export async function runRowProbe(
  w: Writer,
  code: string,
  opts: RunRowProbeOptions,
): Promise<RecordedProbe & { probe: ProbeRunResult }> {
  const row = getDbRow(w, code);
  const actor = opts.actor ?? ownerActor(w);
  const probe = checkedProbe(w, row, actor);
  const result = await executeCommandProbe(probe, {
    cwd: opts.repoDir,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const rec = recordProbeResult(
    w,
    getDbRow(w, row.id),
    result,
    { kind: opts.target, sha: gitHead(opts.repoDir) ?? null },
    actor,
    opts.now,
  );
  return { ...rec, probe: result };
}

export interface RecordedProbe {
  result_id: string;
  event_id: string;
  status: ProbeStatus;
  /** Set when a failing re-run moved a done or watching row to regressed. */
  regressed?: boolean;
}

/**
 * Records a probe run: last_probe_status/at on the row and a ledger.probe_executed event, in one
 * transaction. A failing re-run of a done or watching row moves it to regressed (with
 * ledger.row_regressed) in the same transaction.
 */
export function recordProbeResult(
  w: Writer,
  row: DbRow,
  result: ProbeRunResult,
  target: { kind: TargetKind; sha: string | null },
  actor?: Actor,
  now: () => Date = () => new Date(),
): RecordedProbe {
  return w.transaction((tx) => {
    const a = actor ?? ownerActor(tx);
    const resultId = newId('prr');
    const at = nowIso(now());
    tx.run('UPDATE ledger_rows SET last_probe_status = ?, last_probe_at = ? WHERE id = ?', [
      result.status,
      at,
      row.id,
    ]);
    const ev = tx.appendEvent({
      type: 'ledger.probe_executed',
      actor_kind: a.kind,
      actor_id: a.id,
      project_id: row.project_id,
      stream_id: row.stream_id,
      idempotency_key: resultId,
      payload: {
        ledger_row_id: row.id,
        code: codeFromRowId(row.id),
        probe_revision: row.probe_revision,
        probe_hash: row.probe_hash,
        target_kind: target.kind,
        target_sha: target.sha,
        status: result.status,
        result_id: resultId,
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out,
        duration_ms: result.duration_ms,
        output_tail: result.output_tail,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    });
    const out: RecordedProbe = { result_id: resultId, event_id: ev.id, status: result.status };
    if (result.status === 'fail' && (row.status === 'done' || row.status === 'watching')) {
      transitionRow(tx, row.id, 'regressed', {
        actor: a,
        guard_evidence: { failing_result_id: resultId, target_sha: target.sha },
      });
      tx.appendEvent({
        type: 'ledger.row_regressed',
        actor_kind: a.kind,
        actor_id: a.id,
        project_id: row.project_id,
        stream_id: row.stream_id,
        idempotency_key: `${row.id}+${resultId}`,
        payload: {
          ledger_row_id: row.id,
          previous_status: row.status,
          failing_result_id: resultId,
          suspected_sha: target.sha,
        },
      });
      out.regressed = true;
    }
    return out;
  });
}
