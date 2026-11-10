// In-process core client of the daemon: the ledger's client (every ledger, work order and audit
// command) plus the run commands, which need the daemon's runtime. The CLI finds it through the
// `fw.coreClient` field of this package's package.json (priority 20, above the ledger's 10), so the
// CLI still imports only @fw/contracts.
// One process holds one writer lock: the run commands close the ledger client's store first.
// When fwd is running it holds the writer lock, so `runStart` hands the run to fwd over loopback HTTP
// (POST /v1/runs, CLI token) and fwd owns it. `status` asks fwd (GET /v1/status) and, when fwd is
// down, reads the database read-only.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openStore, type Store, type Writer, WriterLockError } from '@fw/eventlog';
import {
  createCoreClient as createLedgerClient,
  dbPath,
  LedgerError,
  type LocalClientOptions,
  type LocalCoreClient,
  ownerId,
  resolveHome,
} from '@fw/ledger';
import {
  type ApplyReport,
  applyPolicy,
  type Decision,
  type DecisionInput,
  decide,
  findPolicy,
  loadPolicy,
} from '@fw/policy';
import { type ChainStatus, statusOf } from './api/status.ts';
import { REPO_ROOT, VERSION } from './daemon.ts';
import { FwdUnreachableError, fwdEndpoint, fwdError, fwdRequest } from './fwd-client.ts';
import type { DraftView } from './overseer/drafts.ts';
import { supervisorView } from './overseer/index.ts';
import { listRuns, type RunDetail, type RunSummary, showRun } from './pipeline/queries.ts';
import { type RunStartReport, resolveGitHost, runStart } from './pipeline/run-start.ts';
import { type GitReconcileReport, reconcileGitHost } from './reconcile-git.ts';
import {
  type RelayOwedReport,
  type RelayPrompt,
  type RelayResult,
  relayOwed,
  relayPrompt,
  relayResult,
} from './relay/src/index.ts';
import { type DoctorReport, runDoctor } from './runtime/doctor.ts';
import { type GcReport, gcRunDirs } from './runtime/gc.ts';
import { type SetupReport, setupReport } from './setup/index.ts';
import { SPEND_GROUP_NAMES, type SpendGroup, type SpendRow, spendRollup } from './spend.ts';

export interface RunStartRequest {
  adapter?: string;
  scenario?: string;
  base?: string;
  host?: string;
  maxWallClockS?: number;
  repoDir?: string;
}

/**
 * `fw status`: GET /v1/status when fwd answers (`daemon: "up"`, `source: "daemon"`); otherwise the
 * same figures read from the database read-only (`daemon: "down"`, `source: "database"`, `started_at`
 * null). `daemon_detail` says why fwd was not asked. `database: false` when no database exists yet.
 */
export type StatusReport = Record<string, unknown> & {
  daemon: 'up' | 'down';
  source: 'daemon' | 'database';
  home: string;
  database: boolean;
};

export type SupervisorAction = 'pause' | 'resume' | 'enable' | 'disable';
/** GET /v1/supervisor with where it was read from: fwd, or the database read-only when fwd is down. */
export type SupervisorReport = Record<string, unknown> & { source: 'daemon' | 'database' };
export type SupervisorRunReport = { fire_id: string; outcome: string; reason?: string };

export interface DaemonCoreClient extends LocalCoreClient {
  status(): Promise<StatusReport>;
  runStart(code: string, opts?: RunStartRequest): Promise<RunStartReport>;
  runList(opts?: { status?: string; limit?: number }): Promise<RunSummary[]>;
  runShow(runId: string): Promise<RunDetail>;
  supervisorStatus(): Promise<SupervisorReport>;
  supervisorControl(action: SupervisorAction, flow?: string): Promise<SupervisorReport>;
  supervisorDial(flow: string, stop: string, confirm?: string): Promise<SupervisorReport>;
  supervisorRun(flow: string): Promise<SupervisorRunReport>;
  flowApi(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown>;
  supervisorDrafts(flow: string): Promise<DraftView[]>;
  supervisorDraft(action: 'approve' | 'reject', flow: string, id: string): Promise<DraftView>;
  spendRollup(opts: { by: string }): Promise<(SpendRow & { unknown_runs?: number })[]>;
  policyCheck(input: DecisionInput): Promise<Decision & { policy_path: string }>;
  policyApply(): Promise<ApplyReport & { policy_path: string }>;
  reconcile(opts?: { host?: string }): Promise<GitReconcileReport>;
  relayPrompt(order: string): Promise<RelayPrompt>;
  relayOwed(opts?: { olderThanHours?: number }): Promise<RelayOwedReport>;
  relayResult(runId: string, text: string): Promise<RelayResult>;
  doctor(): Promise<DoctorReport>;
  gc(): Promise<GcReport>;
  /** FW-C-039: GET /v1/setup from fwd, or the same report read here when fwd is down. */
  setup(): Promise<SetupReport>;
}

class OwnerOnlyError extends Error {
  readonly code = 'OWNER_ONLY';
}

export function createCoreClient(opts: LocalClientOptions): DaemonCoreClient {
  const ledger = createLedgerClient(opts);
  const home = resolveHome(opts.home);
  const path = dbPath(home);
  const repoDir = resolve(opts.repoDir);
  let store: Store | undefined;
  let readonly = true;

  const open = (write: boolean): Store => {
    if (store && (!write || !readonly)) return store;
    store?.close();
    store = undefined;
    ledger.close();
    if (!existsSync(path))
      throw new LedgerError('NO_DATABASE', `no ledger database at ${path} (run fw ledger sync first)`);
    mkdirSync(dirname(path), { recursive: true });
    // One writer lock for the CLI and fwd: the same file fwd takes, so they can never both write.
    store = openStore({ path, readonly: !write, lockPath: join(home, 'fwd.lock') });
    readonly = !write;
    return store;
  };
  /** Ledger calls go to the ledger client, which opens its own store: release ours first. */
  const viaLedger =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      store?.close();
      store = undefined;
      return fn(...a);
    };

  return {
    home: ledger.home,
    dbPath: ledger.dbPath,
    ledgerSync: viaLedger(ledger.ledgerSync),
    ledgerList: viaLedger(ledger.ledgerList),
    ledgerShow: viaLedger(ledger.ledgerShow),
    ledgerNext: viaLedger(ledger.ledgerNext),
    ledgerRetest: viaLedger(ledger.ledgerRetest),
    ledgerClose: viaLedger(ledger.ledgerClose),
    woIssue: viaLedger(ledger.woIssue),
    auditVerify: viaLedger(ledger.auditVerify),
    async status() {
      const ep = fwdEndpoint(home);
      let detail: string;
      if (!ep.token && process.env.FW_DEV_NO_AUTH !== '1') {
        detail = `no CLI token in ${join(home, 'pairing')} (fwd has never run in this home)`;
      } else {
        try {
          const res = await fwdRequest(ep, 'GET', '/v1/status', undefined, 5000);
          if (res.status === 200) {
            const data = (res.body.data ?? {}) as Record<string, unknown>;
            return {
              ...data,
              daemon: 'up',
              source: 'daemon',
              home,
              database: true,
              port: ep.port,
              head_seq: res.body.head_seq ?? null,
            } as StatusReport;
          }
          detail = `fwd on 127.0.0.1:${ep.port} answered HTTP ${res.status}: ${fwdError(res).message}`;
        } catch (e) {
          if (!(e instanceof FwdUnreachableError)) throw e;
          detail = e.message;
        }
      }
      // Fallback: a direct read-only database read. Never takes the writer lock, never writes.
      const base = { daemon: 'down' as const, source: 'database' as const, home, daemon_detail: detail };
      store?.close();
      store = undefined;
      ledger.close();
      if (!existsSync(path)) return { ...base, database: false, started_at: null, chain: null };
      const ro = openStore({ path, readonly: true, lockPath: join(home, 'fwd.lock') });
      try {
        const reader = ro.reader();
        const v = ro.verifyChain();
        const head = reader.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM events')?.s ?? 0;
        const chain: ChainStatus = {
          ok: v.ok,
          head_seq: head,
          head_hash: v.ok && v.count > 0 ? v.head : null,
          verified_at: new Date().toISOString(),
          failed_seq: v.ok ? null : v.seq,
        };
        const stopped = reader.get<{ ts: string; payload: string }>(
          "SELECT ts, payload FROM events WHERE type IN ('system.started','system.stopped') ORDER BY seq DESC LIMIT 1",
        );
        return {
          ...statusOf({ reader, version: VERSION, startedAt: null, chain: () => chain }),
          ...base,
          database: true,
          started_at: null,
          head_seq: head,
          last_daemon_event: stopped ? { ts: stopped.ts, ...(JSON.parse(stopped.payload) as object) } : null,
        };
      } finally {
        ro.close();
      }
    },
    async setup() {
      const ep = fwdEndpoint(home);
      if (ep.token || process.env.FW_DEV_NO_AUTH === '1') {
        try {
          const res = await fwdRequest(ep, 'GET', '/v1/setup', undefined, 5000);
          if (res.status === 200) return { ...(res.body.data as SetupReport), fwd: 'up' as const };
        } catch (e) {
          if (!(e instanceof FwdUnreachableError)) throw e;
        }
      }
      // fwd is down (or this home never ran it): the same report, read-only, with the machine step open.
      store?.close();
      store = undefined;
      ledger.close();
      const deps = { fwHome: home, repoRoot: REPO_ROOT, fwdUp: false, port: ep.port };
      if (!existsSync(path)) return setupReport({ ...deps, reader: null });
      const ro = openStore({ path, readonly: true, lockPath: join(home, 'fwd.lock') });
      try {
        return setupReport({ ...deps, reader: ro.reader() });
      } finally {
        ro.close();
      }
    },
    streamAdd: viaLedger(ledger.streamAdd),
    streamList: viaLedger(ledger.streamList),
    projectList: viaLedger(ledger.projectList),
    // FW-C-039: project writes work while fwd runs. fwd holds the writer, so they go to it.
    projectLabel: (ref, change) =>
      viaFwdWhenLocked(
        () => viaLedger(ledger.projectLabel)(ref, change),
        'POST',
        `/v1/projects/${encodeURIComponent(ref)}/labels`,
        change,
      ),
    projectAdd: (input) =>
      viaFwdWhenLocked(() => viaLedger(ledger.projectAdd)(input), 'POST', '/v1/projects', input),
    projectBrief: (ref, answers) =>
      answers
        ? viaFwdWhenLocked(
            () => viaLedger(ledger.projectBrief)(ref, answers),
            'POST',
            `/v1/projects/${encodeURIComponent(ref)}/brief`,
            answers,
          )
        : viaLedger(ledger.projectBrief)(ref),
    async runStart(code, o = {}) {
      let writer: Writer;
      try {
        writer = open(true).writer!;
      } catch (e) {
        // fwd holds the writer: hand the run to it, so fwd owns the run (and can interrupt it).
        if (e instanceof WriterLockError) return runStartViaFwd(e, code, o);
        throw e;
      }
      return runStart(writer, code, {
        home,
        repoDir: resolve(o.repoDir ?? repoDir),
        ...(o.adapter !== undefined ? { adapter: o.adapter } : {}),
        ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
        ...(o.base !== undefined ? { base: o.base } : {}),
        ...(o.host !== undefined ? { host: o.host } : {}),
        ...(o.maxWallClockS !== undefined ? { maxWallClockS: o.maxWallClockS } : {}),
      });
    },
    async runList(o = {}) {
      return listRuns(open(false).reader(), o);
    },
    async runShow(runId) {
      return showRun(open(false).reader(), runId);
    },
    async spendRollup({ by }) {
      if (!SPEND_GROUP_NAMES.includes(by as SpendGroup))
        throw new LedgerError('BAD_ARGUMENT', `--by must be one of ${SPEND_GROUP_NAMES.join(', ')}`);
      return spendRollup(open(false).reader(), { by: by as SpendGroup, unknown: true });
    },
    async policyCheck(input) {
      // A dry run: reads the policy file, never the database.
      const policyPath = findPolicy(repoDir, home);
      return { ...decide(loadPolicy(policyPath), input), policy_path: policyPath };
    },
    async policyApply() {
      // Only the Owner compiles the policy. Inside an agent run the sandbox sets FW_RUN_ID.
      if (process.env.FW_RUN_ID)
        throw new OwnerOnlyError('fw policy apply is Owner-only and refuses to run inside an agent run');
      const policyPath = findPolicy(repoDir, home);
      const policy = loadPolicy(policyPath);
      const w = open(true).writer!;
      return { ...applyPolicy(w, policy, ownerId(w)), policy_path: policyPath };
    },
    async reconcile(o = {}) {
      const host = resolveGitHost(o.host ?? process.env.FW_GIT_HOST, repoDir, process.env);
      return reconcileGitHost(open(true).writer!, host);
    },
    async relayPrompt(order) {
      return relayPrompt(open(true).writer!, order);
    },
    async relayOwed(o = {}) {
      return relayOwed(open(true).writer!, o);
    },
    async relayResult(runId, text) {
      return relayResult(open(true).writer!, runId, text);
    },
    async doctor() {
      // The last backup is read from the event log; no database yet means no backup either.
      let lastBackupAt: string | null = null;
      if (existsSync(path)) {
        const row = open(false)
          .reader()
          .get<{ ts: string }>(
            "SELECT ts FROM events WHERE type = 'system.backup_completed' ORDER BY seq DESC LIMIT 1",
          );
        lastBackupAt = row?.ts ?? null;
      }
      return runDoctor(home, { repoDir, lastBackupAt });
    },
    async gc() {
      // No database means no run was ever started in this home, so no directory has a live run.
      if (!existsSync(path)) return gcRunDirs(home, () => undefined);
      const r = open(false).reader();
      return gcRunDirs(
        home,
        (runId) => r.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', [runId])?.status,
      );
    },
    async supervisorStatus() {
      const ep = fwdEndpoint(home);
      if (ep.token || process.env.FW_DEV_NO_AUTH === '1') {
        try {
          const res = await fwdRequest(ep, 'GET', '/v1/supervisor', undefined, 5000);
          if (res.status === 200)
            return { ...((res.body.data ?? {}) as object), source: 'daemon' } as SupervisorReport;
          throw fwdError(res);
        } catch (e) {
          if (!(e instanceof FwdUnreachableError)) throw e;
        }
      }
      // fwd is down: the same view, read from the database read-only. Never writes.
      store?.close();
      store = undefined;
      ledger.close();
      if (!existsSync(path))
        throw new LedgerError(
          'NO_DATABASE',
          `no ledger database at ${path} (start fwd or run fw ledger sync first)`,
        );
      const ro = openStore({ path, readonly: true, lockPath: join(home, 'fwd.lock') });
      try {
        return {
          ...supervisorView({ reader: ro.reader(), repoRoot: REPO_ROOT, fwHome: home }),
          source: 'database',
        };
      } finally {
        ro.close();
      }
    },
    supervisorControl(action, flow) {
      const path =
        action === 'pause' || action === 'resume'
          ? `/v1/supervisor/${action}`
          : `/v1/supervisor/flows/${encodeURIComponent(flow ?? '')}/${action}`;
      return supervisorPost(path, {});
    },
    supervisorDial(flow, stop, confirm) {
      const path = `/v1/supervisor/flows/${encodeURIComponent(flow)}/dial`;
      return supervisorPost(path, confirm ? { stop, confirm } : { stop });
    },
    async supervisorRun(flow) {
      const path = `/v1/supervisor/flows/${encodeURIComponent(flow)}/run`;
      return (await supervisorPost(path, {})) as unknown as SupervisorRunReport;
    },
    async flowApi(method, path, body) {
      // FW-C-048: hunts and do-not-contact live with fwd, so these calls need it running.
      const ep = fwdEndpoint(home);
      let res: Awaited<ReturnType<typeof fwdRequest>>;
      try {
        res = await fwdRequest(ep, method, path, body, 30000);
      } catch (e) {
        if (e instanceof FwdUnreachableError)
          throw Object.assign(new Error(`this goes through fwd, and fwd is not running: ${e.message}`), {
            code: 'UNAVAILABLE',
          });
        throw e;
      }
      if (res.status < 200 || res.status > 299) throw fwdError(res);
      return res.body.data;
    },
    // FW-C-046: Copilot. fwd holds the drafts' writer, so these always go through it.
    async supervisorDrafts(flow) {
      return (await fwdData('GET', `/v1/supervisor/flows/${encodeURIComponent(flow)}/drafts`)) as DraftView[];
    },
    async supervisorDraft(action, flow, id) {
      const path = `/v1/supervisor/flows/${encodeURIComponent(flow)}/drafts/${encodeURIComponent(id)}/${action}`;
      return (await fwdData('POST', path, {})) as DraftView;
    },
    close() {
      store?.close();
      store = undefined;
      ledger.close();
    },
  };

  async function fwdData(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Awaited<ReturnType<typeof fwdRequest>>;
    try {
      res = await fwdRequest(fwdEndpoint(home), method, path, body, 10000);
    } catch (e) {
      if (e instanceof FwdUnreachableError)
        throw Object.assign(
          new Error(`the Supervisor is controlled through fwd, and fwd is not running: ${e.message}`),
          { code: 'UNAVAILABLE' },
        );
      throw e;
    }
    if (res.status !== 200) throw fwdError(res);
    return res.body.data;
  }

  async function supervisorPost(path: string, body: Record<string, unknown>): Promise<SupervisorReport> {
    const ep = fwdEndpoint(home);
    let res: Awaited<ReturnType<typeof fwdRequest>>;
    try {
      res = await fwdRequest(ep, 'POST', path, body, 10000);
    } catch (e) {
      if (e instanceof FwdUnreachableError)
        throw Object.assign(
          new Error(`the Supervisor is controlled through fwd, and fwd is not running: ${e.message}`),
          { code: 'UNAVAILABLE' },
        );
      throw e;
    }
    if (res.status !== 200) throw fwdError(res);
    return { ...((res.body.data ?? {}) as object), source: 'daemon' } as SupervisorReport;
  }

  /** Runs a ledger write here; when fwd holds the writer lock, sends the same write to fwd instead. */
  async function viaFwdWhenLocked<R>(
    local: () => Promise<R>,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
  ): Promise<R> {
    try {
      return await local();
    } catch (e) {
      if (!(e instanceof WriterLockError)) throw e;
      const ep = fwdEndpoint(home);
      let res: Awaited<ReturnType<typeof fwdRequest>>;
      try {
        res = await fwdRequest(ep, method, path, body);
      } catch (f) {
        if (f instanceof FwdUnreachableError) {
          e.message = `${e.message} (and no fwd answered on 127.0.0.1:${ep.port}; set FW_PORT to the port fwd listens on)`;
          throw e;
        }
        throw f;
      }
      if (res.status !== 200) throw fwdError(res);
      return res.body.data as R;
    }
  }

  async function runStartViaFwd(
    lock: WriterLockError,
    code: string,
    o: RunStartRequest,
  ): Promise<RunStartReport> {
    const ep = fwdEndpoint(home);
    let res: Awaited<ReturnType<typeof fwdRequest>>;
    try {
      res = await fwdRequest(ep, 'POST', '/v1/runs', {
        code,
        repo_dir: resolve(o.repoDir ?? repoDir),
        ...(o.adapter !== undefined ? { adapter: o.adapter } : {}),
        ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
        ...(o.base !== undefined ? { base: o.base } : {}),
        ...(o.host !== undefined ? { host: o.host } : {}),
        ...(o.maxWallClockS !== undefined ? { max_wall_clock_s: o.maxWallClockS } : {}),
      });
    } catch (e) {
      // Nothing answers on the port: whoever holds the lock is not a reachable fwd. Report the lock.
      if (e instanceof FwdUnreachableError) {
        lock.message = `${lock.message} (and no fwd answered on 127.0.0.1:${ep.port}; set FW_PORT to the port fwd listens on)`;
        throw lock;
      }
      throw e;
    }
    if (res.status !== 200) throw fwdError(res);
    return res.body.data as RunStartReport;
  }
}
