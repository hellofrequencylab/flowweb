// WS-P0-041: `fw run start <row>`, the single-command pipeline. In C0 the CLI calls this in-process
// (through the daemon's core client); in C1 the same function becomes the daemon's run job.
//   1. premise (an open row is re-tested; the probe must fail)      6. adapter under the supervisor
//   2. work order, run (queued), lease with fence token, admission   7. diff policy (quarantine on deny)
//   3. worktree $FW_HOME/worktrees/<run> on fw/<row>/<run>           8. artifact guard (kernel-verified commit)
//   4. sandbox and its self-test (level on run.started)              9. evidence bundle (probe, checks, policy)
//   5. credentials from handles, into the vendor env only           10. push, PR, evidence comment, verifying
// Any failure ends the run with a failure_class, releases the lease, returns the row to a legal state
// and keeps the worktree and branch for inspection. The Owner merges; `fw ledger close` finishes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  ADAPTER_CREDENTIALS,
  type AdapterEvent,
  type AdapterName,
  createAdapter,
  DEFAULT_ADAPTER,
  isAdapterName,
  type RunStep,
  type VendorAdapter,
  type VendorAdapterInput,
} from '@fw/adapters';
import type { EvidenceBundle, WorkOrder } from '@fw/contracts';
import { validate } from '@fw/contracts';
import { canonicalJson, newId, nowIso, sha256Hex, type Writer } from '@fw/eventlog';
import {
  codeFromRowId,
  executeCommandProbe,
  getDbRow,
  issueWorkOrder,
  LedgerError,
  type ProbeDefinition,
  retestPremise,
  runRowProbe,
  surfaceDbRefusal,
  transitionRow,
} from '@fw/ledger';
import { type DiffVerdict, evaluateDiffPolicy, isDependencyManifest } from '@fw/policy';
import {
  CredentialError,
  type InjectedCredentials,
  injectCredentials,
  redactLiterals,
} from '../creds/index.ts';
import { GhHost, type GitHost, GitHostError, LocalBareHost } from '../edge-git/index.ts';
import { checkRunArtifact } from '../runtime/artifact-guard.ts';
import { branchChanges, branchManifests, branchPatch } from '../runtime/branch-diff.ts';
import { ExecError, execOk, git } from '../runtime/exec.ts';
import { quarantineBranch } from '../runtime/quarantine.ts';
import {
  type ControlName,
  prepareSandbox,
  type SelfTestReport,
  sandboxSelfTest,
} from '../runtime/sandbox.ts';
import { AGENT_INSTRUCTION_FILES, TIER0_PATHS } from '../runtime/tier0.ts';
import { runBranchName, WorktreeManager } from '../runtime/worktrees.ts';
import { buildEvidenceBundle, diffFileStats, type EvidenceInput, prComment } from './evidence.ts';
import {
  ACTIVE_RUN_STATES,
  type EndState,
  endRun,
  type FailureClass,
  getRun,
  releaseLeases,
  SUPERVISOR,
} from './records.ts';
import { type SupervisedOutcome, type SupervisedRun, startSupervised } from './supervisor.ts';

export const LEASE_RESOURCE_KIND = 'branch';
export const HEARTBEAT_MS = 30_000;
const DEFAULT_WALL_CLOCK_S = 30 * 60;
const DEFAULT_TURNS = 100;

export class PipelineError extends Error {
  readonly code: 'BAD_ARGUMENT' | 'HOST_UNAVAILABLE' | 'UNAVAILABLE';
  readonly details: Record<string, unknown>;
  constructor(code: PipelineError['code'], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.details = details;
  }
}

export interface RunStartOptions {
  /** FW_HOME. */
  home: string;
  /** The project checkout (main worktree) the run branches from. */
  repoDir: string;
  /** An adapter name from @fw/adapters. Default $FW_VENDOR, else the adapters package default. */
  adapter?: string;
  /** Fake adapter only: the scripted scenario. */
  scenario?: string;
  /** Pull request base branch. Default: the project's default branch. */
  base?: string;
  /** gh | local | local:<bare repo path>. Default $FW_GIT_HOST, else local when origin is a local path, else gh. */
  host?: string;
  /** Tightens the wall-clock cap below the work order's (never loosens it). */
  maxWallClockS?: number;
  /** Sandbox controls the run refuses to proceed without (C0 default: none). */
  requiredControls?: ControlName[];
  /** Use the OS keychain for credential handles. Default true. */
  keychain?: boolean;
  /** Tests: a ready-made git host and adapter. */
  gitHost?: GitHost;
  adapterFactory?: (name: AdapterName) => VendorAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Aborted when the host stops (fwd on SIGTERM). The run in flight is killed (its whole vendor
   * process group) and ends as killed, failure_class killed, with the abort reason (which says
   * "interrupted") in its terminal event. A run aborted before its vendor starts ends as failed.
   */
  signal?: AbortSignal;
}

export interface RunStartReport {
  code: string;
  ok: boolean;
  run_id: string | null;
  /** The run's final status, or `refused` when no run was started. */
  status: string;
  failure_class: string | null;
  reason: string | null;
  /** Set when a policy refused the run's change (`DIFF_POLICY`); the CLI exits 3 on it. */
  policy_code: string | null;
  row_status: string;
  work_order_id: string | null;
  branch: string | null;
  worktree: string | null;
  pr: { number: number; url: string; head_sha: string; comment_url: string | null } | null;
  evidence_bundle_id: string | null;
  bundle_hash: string | null;
  sandbox_level: string | null;
  cost_usd: number | null;
  cost_estimated: boolean | null;
}

/** An expected way for a started run to end. */
class RunFailure extends Error {
  readonly failure_class: FailureClass;
  readonly to: EndState | undefined;
  readonly extra: Record<string, unknown>;
  constructor(fc: FailureClass, detail: string, extra: Record<string, unknown> = {}, to?: EndState) {
    super(detail);
    this.failure_class = fc;
    this.extra = extra;
    this.to = to;
  }
}

/** The reason an aborted signal carries, as text for the run's terminal event. */
function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  const text = typeof r === 'string' ? r : r instanceof Error ? r.message : '';
  return /interrupt/i.test(text) ? text : `interrupted${text ? `: ${text}` : ''}`;
}

/** Throws the interrupted failure when the host has stopped. */
function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new RunFailure('killed', abortReason(signal), { cause: 'interrupted' }, 'killed');
}

/** A started run whose change a policy refused. `code` is what the CLI maps to exit 3. */
class PolicyRefusal extends RunFailure {
  readonly code = 'DIFF_POLICY';
}

const clip = (s: string, max = 500) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- git host -----------------------------------------------------------------------------------

function originUrl(repoDir: string): string | null {
  try {
    return gitSync(repoDir, ['remote', 'get-url', 'origin']) || null;
  } catch {
    return null;
  }
}

function gitSync(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return (r.stdout ?? '').trim();
}

function localPathOf(url: string): string | null {
  if (url.startsWith('file://')) return new URL(url).pathname;
  if (isAbsolute(url)) return url;
  return null;
}

/** owner/name from a GitHub-style remote URL (https or scp-like ssh). */
export function hostRepoOf(url: string): string | null {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function resolveGitHost(spec: string | undefined, repoDir: string, env: NodeJS.ProcessEnv): GitHost {
  const origin = originUrl(repoDir);
  const local = origin ? localPathOf(origin) : null;
  const s = spec ?? (local ? 'local' : 'gh');
  if (s.startsWith('local:')) return new LocalBareHost(resolve(repoDir, s.slice('local:'.length)));
  if (s === 'local') {
    if (!local)
      throw new PipelineError(
        'HOST_UNAVAILABLE',
        `--host local needs an origin remote that is a local bare repository (origin is ${origin ?? 'not set'}); pass --host local:<path>`,
      );
    return new LocalBareHost(local);
  }
  if (s === 'gh') {
    const repo = origin ? hostRepoOf(origin) : null;
    if (!repo)
      throw new PipelineError(
        'HOST_UNAVAILABLE',
        `--host gh needs an origin remote of the form owner/name (origin is ${origin ?? 'not set'})`,
      );
    return new GhHost({ repo, env });
  }
  throw new PipelineError(
    'BAD_ARGUMENT',
    `unknown git host ${JSON.stringify(s)} (gh, local or local:<path>)`,
  );
}

// ---- small reads ---------------------------------------------------------------------------------

function killSwitchEngaged(w: Writer): boolean {
  const v = w.get<{ value: string }>("SELECT value FROM settings WHERE key = 'kill_switch'");
  try {
    return (JSON.parse(v?.value ?? '{}') as { engaged?: unknown }).engaged === true;
  } catch {
    return false;
  }
}

function leaseTtlMs(w: Writer): number {
  const v = w.get<{ value: string }>("SELECT value FROM settings WHERE key = 'leases.ttl_minutes'");
  const n = Number(v ? JSON.parse(v.value) : 20);
  return (Number.isFinite(n) && n > 0 ? n : 20) * 60_000;
}

interface WoRow {
  id: string;
  status: string;
  body: string;
  doer_agent_id: string;
  expires_at: string;
  project_id: string;
  stream_id: string;
}

function liveWorkOrder(w: Writer, rowId: string): WoRow | undefined {
  return w.get<WoRow>(
    `SELECT id, status, body, doer_agent_id, expires_at, project_id, stream_id FROM work_orders
      WHERE ledger_row_id = ? AND status IN ('issued','running') ORDER BY version DESC LIMIT 1`,
    [rowId],
  );
}

function rowPullRequest(w: Writer, rowId: string): string | null {
  return (
    w.get<{ ref: string }>(
      `SELECT a.ref FROM run_artifacts a JOIN runs r ON r.id = a.run_id JOIN work_orders o ON o.id = r.work_order_id
        WHERE o.ledger_row_id = ? AND a.kind = 'pull_request' AND a.verified_by_kernel = 1 ORDER BY a.id DESC LIMIT 1`,
      [rowId],
    )?.ref ?? null
  );
}

async function refSha(repoDir: string, ref: string): Promise<string | null> {
  try {
    return await git(repoDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  } catch (e) {
    if (e instanceof ExecError) return null;
    throw e;
  }
}

// ---- the pipeline --------------------------------------------------------------------------------

export async function runStart(w: Writer, code: string, opts: RunStartOptions): Promise<RunStartReport> {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const fwHome = resolve(opts.home);
  const repoDir = resolve(opts.repoDir);
  for (const d of ['worktrees', 'runs']) mkdirSync(join(fwHome, d), { recursive: true, mode: 0o700 });

  const adapterName = opts.adapter ?? env.FW_VENDOR ?? DEFAULT_ADAPTER;
  if (!isAdapterName(adapterName))
    throw new PipelineError('BAD_ARGUMENT', `unknown adapter ${JSON.stringify(adapterName)}`);
  if (opts.scenario !== undefined && adapterName !== 'fake')
    throw new PipelineError('BAD_ARGUMENT', '--scenario applies to the fake adapter only');
  if (opts.maxWallClockS !== undefined && !(Number.isInteger(opts.maxWallClockS) && opts.maxWallClockS > 0))
    throw new PipelineError('BAD_ARGUMENT', '--max-wall-clock-s must be a positive whole number of seconds');

  if (opts.signal?.aborted) throw new PipelineError('UNAVAILABLE', abortReason(opts.signal));
  let row = getDbRow(w, code);
  const rowCode = codeFromRowId(row.id);
  const report: RunStartReport = {
    code: rowCode,
    ok: false,
    run_id: null,
    status: 'refused',
    failure_class: null,
    reason: null,
    policy_code: null,
    row_status: row.status,
    work_order_id: null,
    branch: null,
    worktree: null,
    pr: null,
    evidence_bundle_id: null,
    bundle_hash: null,
    sandbox_level: null,
    cost_usd: null,
    cost_estimated: null,
  };
  const refuse = (reason: string): RunStartReport => ({
    ...report,
    reason,
    row_status: getDbRow(w, row.id).status,
  });

  // ---- 1. premise ----
  if (killSwitchEngaged(w)) return refuse('kill switch is engaged; no new runs');
  if (row.status === 'open') {
    const p = await retestPremise(w, rowCode, { repoDir });
    if (p.outcome !== 'ready')
      return refuse(
        p.still_valid === false
          ? `premise already satisfied: the probe passes on ${p.base_sha ?? 'the checkout'}, so the row was parked`
          : `premise re-test inconclusive (${p.probe.timed_out ? 'timed out' : (p.probe.error ?? p.probe.status)}); the row stays ${p.to}`,
      );
    row = getDbRow(w, row.id);
  }
  if (row.status !== 'ready' && row.status !== 'claimed') {
    const pr = rowPullRequest(w, row.id);
    return refuse(
      `${rowCode} is ${row.status}; ${pr ? `pull request ${pr} is already open for it` : 'only a ready row can run (fw ledger retest first)'}`,
    );
  }
  const active = w.get<{ id: string; status: string }>(
    `SELECT r.id, r.status FROM runs r JOIN work_orders o ON o.id = r.work_order_id
      WHERE o.ledger_row_id = ? AND r.status IN (${ACTIVE_RUN_STATES.map(() => '?').join(',')}) LIMIT 1`,
    [row.id, ...ACTIVE_RUN_STATES],
  );
  if (active) return refuse(`run ${active.id} is already ${active.status} for ${rowCode}`);

  // ---- 2. work order, run, lease ----
  let wo = liveWorkOrder(w, row.id);
  if (wo && wo.status === 'issued' && wo.expires_at <= nowIso(now())) {
    const expired = wo;
    w.transaction((tx) => {
      tx.run("UPDATE work_orders SET status = 'expired' WHERE id = ? AND status = 'issued'", [expired.id]);
      tx.appendEvent({
        ...SUPERVISOR,
        type: 'work_order.expired',
        project_id: expired.project_id,
        stream_id: expired.stream_id,
        work_order_id: expired.id,
        idempotency_key: `${expired.id}+expired`,
        payload: { work_order_id: expired.id, expires_at: expired.expires_at },
      });
    });
    wo = undefined;
  }
  if (!wo) {
    issueWorkOrder(w, rowCode, { repoDir, home: fwHome });
    wo = liveWorkOrder(w, row.id)!;
  }
  report.work_order_id = wo.id;
  const order = JSON.parse(wo.body) as WorkOrder;
  const host = opts.gitHost ?? resolveGitHost(opts.host ?? env.FW_GIT_HOST, repoDir, env);
  const prBase =
    opts.base ??
    w.get<{ default_branch: string }>('SELECT default_branch FROM projects WHERE id = ?', [row.project_id])
      ?.default_branch ??
    'main';
  const adapter = (opts.adapterFactory ?? ((n: AdapterName) => createAdapter(n)))(adapterName);

  const caps = order.budget.caps;
  const wallS = Math.min(
    caps.max_minutes ? caps.max_minutes * 60 : DEFAULT_WALL_CLOCK_S,
    opts.maxWallClockS ?? Number.POSITIVE_INFINITY,
  );
  const runId = newId('run');
  const leaseId = newId('lse');
  const branch = runBranchName(rowCode, runId);
  const wm = new WorktreeManager({ fwHome, repoPath: repoDir });
  const worktreePath = wm.pathFor(runId);
  const leaseKey = `fw/${rowCode}`;
  const ttlMs = leaseTtlMs(w);
  const woId = wo.id;
  const doer = wo.doer_agent_id;
  const t0 = now();

  try {
    w.transaction((tx) => {
      const fence =
        (tx.get<{ f: number | null }>(
          'SELECT MAX(fence_token) AS f FROM leases WHERE resource_kind = ? AND resource_key = ?',
          [LEASE_RESOURCE_KIND, leaseKey],
        )?.f ?? 0) + 1;
      const attempt =
        (tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE work_order_id = ?', [woId])?.n ?? 0) + 1;
      const expires = nowIso(new Date(t0.getTime() + ttlMs));
      surfaceDbRefusal(() =>
        tx.run(
          `INSERT INTO leases(id, resource_kind, resource_key, holder_agent_id, run_id, status, fence_token, acquired_at, heartbeat_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          [leaseId, LEASE_RESOURCE_KIND, leaseKey, doer, runId, fence, nowIso(t0), nowIso(t0), expires],
        ),
      );
      surfaceDbRefusal(() =>
        tx.run(
          `INSERT INTO runs(id, work_order_id, project_id, stream_id, agent_id, attempt, adapter_name, adapter_vendor,
             status, lease_id, workspace_path, branch, queued_at, deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          [
            runId,
            woId,
            row.project_id,
            order.stream_id,
            doer,
            attempt,
            adapter.name,
            adapter.vendor,
            leaseId,
            worktreePath,
            branch,
            nowIso(t0),
            nowIso(new Date(t0.getTime() + wallS * 1000)),
          ],
        ),
      );
      const ev = {
        ...SUPERVISOR,
        project_id: row.project_id,
        stream_id: order.stream_id,
        work_order_id: woId,
      };
      tx.appendEvent({
        ...ev,
        type: 'lease.acquired',
        run_id: runId,
        idempotency_key: leaseId,
        payload: {
          lease_id: leaseId,
          resource_kind: LEASE_RESOURCE_KIND,
          resource_key: leaseKey,
          holder_agent_id: doer,
          expires_at: expires,
          fence_token: fence,
          run_id: runId,
        },
      });
      tx.appendEvent({
        ...ev,
        type: 'run.queued',
        run_id: runId,
        idempotency_key: runId,
        payload: { run_id: runId, work_order_id: woId, agent_id: doer, vendor: adapter.vendor, attempt },
      });
      if (getDbRow(tx, row.id).status === 'ready')
        transitionRow(tx, row.id, 'claimed', {
          actor: { kind: 'system', id: SUPERVISOR.actor_id },
          guard_evidence: { work_order_id: woId, run_id: runId, lease_id: leaseId },
        });
    });
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'REFUSED_BY_DATABASE') return refuse(e.message);
    throw e;
  }
  report.run_id = runId;
  report.branch = branch;
  report.worktree = worktreePath;

  const finish = (): RunStartReport => {
    const r = w.get<{ status: string; failure_class: string | null; cost_usd: number }>(
      'SELECT status, failure_class, cost_usd FROM runs WHERE id = ?',
      [runId],
    )!;
    const spent = w.get<{ n: number; usd: number | null }>(
      'SELECT COUNT(*) AS n, SUM(usd) AS usd FROM spend_entries WHERE run_id = ?',
      [runId],
    )!;
    return {
      ...report,
      status: r.status,
      failure_class: r.failure_class,
      ok: r.status === 'succeeded',
      row_status: getDbRow(w, row.id).status,
      cost_usd: spent.n > 0 ? (spent.usd ?? 0) : report.cost_usd,
    };
  };

  // Admission: the trigger checks the kill switch, exhausted budgets, the live lease and the order.
  try {
    surfaceDbRefusal(() =>
      w.run("UPDATE runs SET status = 'starting', started_at = ? WHERE id = ? AND status = 'queued'", [
        nowIso(now()),
        runId,
      ]),
    );
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    const budget = /budget/i.test(e.message);
    w.transaction((tx) => {
      endRun(tx, {
        run: getRun(tx, runId),
        to: 'cancelled',
        failure_class: 'cancelled',
        detail: `dispatch refused: ${e.message}`,
        now,
      });
      if (budget) {
        const exhausted = tx.get<{ budget_id: string; scope_kind: string }>(
          `SELECT budget_id, scope_kind FROM budget_usage WHERE max_usd IS NOT NULL AND spent_usd >= max_usd AND period <> 'run' LIMIT 1`,
        );
        tx.appendEvent({
          ...SUPERVISOR,
          type: 'dispatch.refused_budget',
          project_id: row.project_id,
          stream_id: order.stream_id,
          work_order_id: woId,
          run_id: runId,
          idempotency_key: `${woId}+${exhausted?.budget_id ?? 'unknown'}+${runId}`,
          payload: {
            work_order_id: woId,
            budget_id: exhausted?.budget_id ?? null,
            would_exceed: 'usd',
            remaining: 0,
            reason: e.message,
          },
        });
      }
    });
    return { ...finish(), reason: e.message };
  }

  // ---- 3 to 10, under one failure handler ----
  const ctx: ExecCtx = {
    w,
    now,
    fwHome,
    repoDir,
    rowId: row.id,
    rowCode,
    rowTitle: row.title,
    projectId: row.project_id,
    order,
    woId,
    runId,
    leaseId,
    branch,
    wm,
    adapter,
    adapterName,
    host,
    prBase,
    wallS,
    ttlMs,
    report,
    opts,
    creds: null,
    sandbox: null,
  };
  try {
    await execute(ctx);
    // On success the branch is pushed and the PR is open: nothing is left to inspect locally.
    await wm.remove(runId, { force: true }).catch(() => undefined);
    return finish();
  } catch (e) {
    const f =
      e instanceof RunFailure
        ? e
        : e instanceof CredentialError
          ? new RunFailure('adapter', e.message, { credential_error: e.code })
          : e instanceof GitHostError
            ? new RunFailure('adapter', `git host: ${e.message}`)
            : new RunFailure('adapter', `pipeline error: ${msg(e)}`);
    const current = getRun(w, runId);
    let to: EndState;
    if (current.status === 'killed') to = 'killed';
    else if (current.status === 'running') to = f.to ?? 'failed';
    else to = 'failed'; // starting and validating may only fail
    endRun(w, {
      run: current,
      to,
      failure_class: f.failure_class,
      detail: clip(redactLiterals(f.message, ctx.creds?.literals ?? [])),
      extra: { ...f.extra, worktree_kept: existsSync(worktreePath) ? worktreePath : null },
      now,
    });
    report.reason = clip(redactLiterals(f.message, ctx.creds?.literals ?? []));
    report.policy_code = f instanceof PolicyRefusal ? f.code : null;
    const out = finish();
    out.reason = report.reason;
    return out;
  }
}

interface ExecCtx {
  w: Writer;
  now: () => Date;
  fwHome: string;
  repoDir: string;
  rowId: string;
  rowCode: string;
  rowTitle: string;
  projectId: string;
  order: WorkOrder;
  woId: string;
  runId: string;
  leaseId: string;
  branch: string;
  wm: WorktreeManager;
  adapter: VendorAdapter;
  adapterName: AdapterName;
  host: GitHost;
  prBase: string;
  wallS: number;
  ttlMs: number;
  report: RunStartReport;
  opts: RunStartOptions;
  creds: InjectedCredentials | null;
  sandbox: SelfTestReport | null;
}

function evBase(c: ExecCtx) {
  return {
    ...SUPERVISOR,
    project_id: c.projectId,
    stream_id: c.order.stream_id,
    work_order_id: c.woId,
    run_id: c.runId,
  };
}

async function execute(c: ExecCtx): Promise<void> {
  const { w, now, runId, order } = c;
  const signal = c.opts.signal;
  throwIfInterrupted(signal);

  // ---- 3. worktree ----
  const activeIds = new Set(
    w
      .all<{ id: string }>(
        `SELECT id FROM runs WHERE status IN (${ACTIVE_RUN_STATES.map(() => '?').join(',')})`,
        [...ACTIVE_RUN_STATES],
      )
      .map((r) => r.id),
  );
  // A failed run's worktree is kept for inspection until the row runs again.
  for (const wt of await c.wm.list())
    if (wt.row_id === c.rowCode && !activeIds.has(wt.run_id)) await c.wm.remove(wt.run_id, { force: true });
  const created = await c.wm.create({ run_id: runId, row_id: c.rowCode, base_ref: order.base_commit });
  if (!created.ok) throw new RunFailure('adapter', `worktree refused: ${created.reason} (${created.detail})`);

  // ---- adapter preflight ----
  let fingerprint: { name: string; version: string; help_sha256: string };
  try {
    fingerprint = (await c.adapter.preflight()).fingerprint;
  } catch (e) {
    throw new RunFailure('adapter', `adapter ${c.adapter.name} preflight failed: ${msg(e)}`);
  }
  w.run('UPDATE runs SET adapter_version = ? WHERE id = ?', [fingerprint.version, runId]);
  const fingerprintAt = nowIso(now());

  // ---- 4. sandbox ----
  const sb = prepareSandbox({ fwHome: c.fwHome, run_id: runId, worktreePath: created.path });
  const selftest = await sandboxSelfTest(sb, { now });
  c.sandbox = selftest;
  c.report.sandbox_level = selftest.level;
  const controls = Object.fromEntries(Object.entries(selftest.controls).map(([k, v]) => [k, v.level]));
  const absent = (c.opts.requiredControls ?? []).filter((k) => selftest.controls[k].level === 'absent');
  if (absent.length)
    throw new RunFailure(
      'adapter',
      `sandbox control(s) required by the work order are absent: ${absent.join(', ')}`,
      {
        sandbox: { level: selftest.level, controls },
      },
    );

  // ---- 5. credentials (vendor env only) ----
  c.creds = injectCredentials(
    ADAPTER_CREDENTIALS[c.adapterName].map((r) => ({ ...r, scopes: [...r.scopes] })),
    { home: c.fwHome, ...(c.opts.keychain !== undefined ? { keychain: c.opts.keychain } : {}) },
  );
  const creds = c.creds;

  // ---- 6. adapter under the supervisor ----
  const caps = order.budget.caps;
  const instructionFiles = AGENT_INSTRUCTION_FILES.filter((f) => existsSync(join(created.path, f))).map(
    (f) => ({
      path: f,
      sha256: sha256Hex(readFileSync(join(created.path, f))),
    }),
  );
  const handle = ADAPTER_CREDENTIALS[c.adapterName][0];
  const input: VendorAdapterInput = {
    schema_version: '1',
    run_id: runId,
    attempt: 1,
    work_order: order as unknown as VendorAdapterInput['work_order'],
    workspace: { path: created.path, branch: c.branch, base_commit: order.base_commit, read_only: false },
    credentials_handle: {
      handle_id: handle?.handle ?? 'crd_none0000',
      scopes: handle ? [...handle.scopes] : [],
      expires_at: nowIso(new Date(now().getTime() + (c.wallS + 300) * 1000)),
    },
    budget: { ...caps },
    caps: { max_turns: caps.max_turns ?? DEFAULT_TURNS, max_wall_clock_s: c.wallS },
    result_schema_ref: 'run-result.json',
    sandbox: {
      isolation: 'worktree_only',
      network_policy: 'allowlist',
      egress_allowlist: [...sb.egress.allowlist],
      ...(sb.egress.proxy ? { proxy: sb.egress.proxy } : {}),
    },
    tool_allowlist: [],
    context_provenance: {
      untrusted_inputs: [],
      rule_of_two: {
        untrusted_input: false,
        sensitive_access: creds.used.length > 0,
        state_change_or_external_comms: false,
        score: creds.used.length > 0 ? 1 : 0,
      },
    },
    ...(instructionFiles.length ? { instruction_files: instructionFiles } : {}),
    planner_text_is_data: true,
  };
  const inputCheck = validate('vendor-adapter-input', input);
  if (!inputCheck.ok)
    throw new RunFailure(
      'schema',
      `the vendor adapter input is not valid: ${JSON.stringify(inputCheck.errors).slice(0, 300)}`,
    );
  const inputHash = sha256Hex(canonicalJson(input));
  w.run('UPDATE runs SET input_hash = ? WHERE id = ?', [inputHash, runId]);
  c.report.branch = c.branch;

  const stepsFile = join(sb.runDir, 'steps.jsonl');
  const stepsRef = relative(c.fwHome, stepsFile);
  let model: string | null = null;
  let sup: SupervisedRun | undefined;
  let backstop: string | null = null;
  const handleStep = (s: RunStep) => {
    const content = redactLiterals(s.content, creds.literals);
    appendFileSync(
      stepsFile,
      `${JSON.stringify({ seq: s.seq, kind: s.kind, tool_name: s.tool_name ?? null, content_hash: sha256Hex(content), content })}\n`,
      { mode: 0o600 },
    );
    w.transaction((tx) => {
      tx.run(
        `INSERT INTO run_steps(id, run_id, seq, kind, content_ref, content_hash, tokens_in, tokens_out, cost_usd, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.id,
          runId,
          s.seq,
          s.kind,
          `${stepsRef}#${s.seq}`,
          sha256Hex(content),
          s.tokens_in,
          s.tokens_out,
          s.cost_usd,
          s.started_at,
          s.ended_at,
        ],
      );
      if (s.cost_usd > 0 || s.tokens_in > 0 || s.tokens_out > 0)
        tx.run(
          `INSERT INTO spend_entries(id, project_id, stream_id, run_id, agent_id, kind, vendor, model, tokens_in, tokens_out, usd, idempotency_key)
           VALUES (?, ?, ?, ?, ?, 'model_tokens', ?, ?, ?, ?, ?, ?)`,
          [
            newId('spd'),
            c.projectId,
            order.stream_id,
            runId,
            order.roles.doer,
            c.adapter.vendor,
            model,
            s.tokens_in,
            s.tokens_out,
            s.cost_usd,
            `${runId}:step:${s.seq}`,
          ],
        );
    });
    // The spend trigger is the backstop: a run over its work-order cap is killed in the database.
    if (!backstop && getRun(w, runId).status === 'killed') {
      backstop = 'budget_hard_stop';
      void sup?.stop('budget hard stop: run spend exceeded the work order cap');
    }
  };
  const onEvent = (e: AdapterEvent) => {
    if (e.type === 'step') handleStep(e.step);
    else if (e.type === 'session') {
      if (e.model) model = e.model;
      w.run('UPDATE runs SET session_id = ? WHERE id = ?', [e.session_id, runId]);
    } else if (e.type === 'process' && e.phase === 'spawned') {
      w.transaction((tx) => {
        surfaceDbRefusal(() =>
          tx.run("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'starting'", [runId]),
        );
        tx.run("UPDATE work_orders SET status = 'running' WHERE id = ? AND status = 'issued'", [c.woId]);
        if (getDbRow(tx, c.rowId).status === 'claimed')
          transitionRow(tx, c.rowId, 'running', {
            actor: { kind: 'system', id: SUPERVISOR.actor_id },
            guard_evidence: { run_id: runId, lease_id: c.leaseId },
          });
        tx.appendEvent({
          ...evBase(c),
          type: 'run.started',
          idempotency_key: `${runId}+started`,
          payload: {
            run_id: runId,
            session_id: null,
            adapter_version: fingerprint.version,
            adapter: {
              name: fingerprint.name,
              version: fingerprint.version,
              help_sha256: fingerprint.help_sha256,
            },
            lease_id: c.leaseId,
            workspace_path: created.path,
            branch: c.branch,
            input_hash: inputHash,
            sandbox_level: selftest.level,
            sandbox: { level: selftest.level, mode: selftest.mode, controls },
            vendor_pgid: e.pgid ?? null,
            credentials: creds.used.map((u) => ({ handle: u.handle, source: u.source })),
            caps: { max_wall_clock_s: c.wallS, max_turns: input.caps.max_turns, ...caps },
          },
        });
      });
    }
  };
  const heartbeat = setInterval(() => {
    const at = now();
    try {
      w.run("UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND status = 'active'", [
        nowIso(at),
        nowIso(new Date(at.getTime() + c.ttlMs)),
        c.leaseId,
      ]);
    } catch {
      // the run's own end handling releases the lease
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let out: SupervisedOutcome;
  throwIfInterrupted(signal);
  const onAbort = () => void sup?.stop(abortReason(signal!));
  try {
    sup = startSupervised(c.adapter, input, {
      onEvent,
      startOptions: {
        credentialEnv: creds.env,
        homeDir: sb.homeDir,
        ...(c.opts.scenario !== undefined ? { scenario: c.opts.scenario } : {}),
      },
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    out = await sup.done;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    clearInterval(heartbeat);
  }

  // ---- cost record: per-step entries were written live; add what the vendor reported beyond them ----
  const cost = out.meta.cost;
  const sums = w.get<{ usd: number | null; tin: number | null; tout: number | null }>(
    'SELECT SUM(usd) AS usd, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout FROM spend_entries WHERE run_id = ?',
    [runId],
  )!;
  const usdGap = Math.round((cost.usd - (sums.usd ?? 0)) * 1e6) / 1e6;
  if (usdGap > 0)
    w.run(
      `INSERT INTO spend_entries(id, project_id, stream_id, run_id, agent_id, kind, vendor, model, tokens_in, tokens_out, tokens_cached, usd, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'model_tokens', ?, ?, 0, 0, ?, ?, ?)`,
      [
        newId('spd'),
        c.projectId,
        order.stream_id,
        runId,
        order.roles.doer,
        c.adapter.vendor,
        model,
        cost.cached_tokens,
        usdGap,
        `${runId}:final`,
      ],
    );
  c.report.cost_estimated = cost.estimated;
  const result = out.result;
  const resultHash = sha256Hex(canonicalJson(result));
  const runCols = {
    result: canonicalJson(result),
    result_hash: resultHash,
    exit_code: result.exit_code,
    cost_usd: cost.usd,
    tokens_in: cost.input_tokens,
    tokens_out: cost.output_tokens,
    tokens_cached: cost.cached_tokens,
    turns: result.turns ?? 0,
  };
  w.run(
    `UPDATE runs SET result = ?, result_hash = ?, exit_code = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, tokens_cached = ?, turns = ? WHERE id = ?`,
    [...Object.values(runCols), runId],
  );
  const costPayload = {
    usd: cost.usd,
    estimated: cost.estimated,
    tokens_in: cost.input_tokens,
    tokens_out: cost.output_tokens,
    tokens_cached: cost.cached_tokens,
  };

  // ---- the run's outcome ----
  const status = getRun(w, runId).status;
  if (status === 'killed' || backstop) {
    w.appendEvent({
      ...evBase(c),
      type: 'budget.hard_stop',
      idempotency_key: `wo:${c.woId}+${runId}`,
      payload: {
        budget_id: `wo:${c.woId}`,
        runs_killed: [runId],
        cap_usd: caps.max_usd ?? null,
        cost: costPayload,
      },
    });
    throw new RunFailure(
      'budget',
      `budget hard stop: run spend exceeded the work order cap of $${caps.max_usd}`,
      { cause: 'budget_hard_stop', cost: costPayload },
      'killed',
    );
  }
  if (out.breach) {
    const b = out.breach;
    const base = {
      cap: b.cap,
      limit: b.limit,
      observed: b.observed,
      by: b.by,
      cost: costPayload,
      group_gone: out.group_gone,
    };
    if (b.cap === 'wall_clock')
      throw new RunFailure(
        'timeout',
        `wall-clock cap of ${b.limit} s exceeded; process group killed`,
        base,
        'timed_out',
      );
    if (b.cap === 'turns')
      throw new RunFailure(
        'budget',
        `turn cap of ${b.limit} exceeded; process group killed`,
        base,
        'timed_out',
      );
    throw new RunFailure(
      'budget',
      `${b.cap} cap of ${b.limit} exceeded (${b.observed}); process group killed`,
      {
        ...base,
        cause: 'budget_hard_stop',
      },
      'killed',
    );
  }
  if (out.stopped)
    throw new RunFailure(
      'killed',
      out.stopped,
      {
        cause: signal?.aborted ? 'interrupted' : 'supervisor',
        cost: costPayload,
        group_gone: out.group_gone,
      },
      'killed',
    );
  if (result.status !== 'completed')
    throw new RunFailure(
      (out.meta.failure_class as FailureClass | null) ?? 'adapter',
      `adapter ended ${result.status} (exit ${result.exit_code}): ${result.summary ?? ''}`,
      { cost: costPayload, adapter_errors: out.meta.error_count },
    );

  // ---- validating ----
  w.transaction((tx) => {
    tx.run("UPDATE runs SET status = 'validating' WHERE id = ? AND status = 'running'", [runId]);
    tx.appendEvent({
      ...evBase(c),
      actor_kind: 'adapter',
      actor_id: `adapter.${c.adapter.name}`,
      type: 'run.result_submitted',
      idempotency_key: `${runId}+${resultHash}`,
      payload: { run_id: runId, result_hash: resultHash, status: result.status, exit_code: result.exit_code },
    });
  });
  const resultCheck = validate('run-result', result);
  if (!resultCheck.ok)
    throw new RunFailure(
      'schema',
      `run result is not valid against run-result.json: ${JSON.stringify(resultCheck.errors).slice(0, 300)}`,
    );

  // Claims: every artifact the vendor claimed (not derived from git by the adapter) is re-checked.
  for (let i = 0; i < result.artifacts.length; i++) {
    if (out.meta.artifact_sources[i] !== 'claimed') continue;
    const a = result.artifacts[i]!;
    const found = await verifyClaim(c, a);
    if (!found.ok) {
      const claim = `${a.kind} ${a.ref}`;
      w.appendEvent({
        ...evBase(c),
        actor_kind: 'system',
        actor_id: 'fwd.auditor',
        type: 'run.claim_mismatch',
        idempotency_key: `${runId}+${sha256Hex(claim)}`,
        payload: { run_id: runId, claim, expected_tool_call: null, found: false, detail: found.detail },
      });
      throw new RunFailure('claim_mismatch', `claimed ${claim} does not exist: ${found.detail}`);
    }
  }

  // ---- 7. diff policy ----
  const baseSha = order.base_commit;
  const headSha = await refSha(c.repoDir, `refs/heads/${c.branch}`);
  if (!headSha || headSha === baseSha)
    throw new RunFailure('no_artifact', 'the run made no commit on its branch');
  const changes = await branchChanges(c.repoDir, baseSha, headSha);
  const tier0 = [...new Set([...TIER0_PATHS, ...order.scope.forbidden])];
  const verdict = evaluateDiffPolicy({
    changes,
    allowedFiles: order.scope.touches,
    tier0Paths: tier0,
    patch: await branchPatch(c.repoDir, baseSha, headSha),
    manifests: await branchManifests(c.repoDir, baseSha, headSha, changes, (p) => isDependencyManifest(p)),
    rowSize: getDbRow(c.w, c.rowId).size,
    allowNewDependencies: order.constraints.no_new_dependencies === false,
  });
  const policyAt = nowIso(now());
  if (!verdict.allowed) await quarantine(c, verdict);

  // ---- 8. artifact guard ----
  const local = await checkRunArtifact({
    repoPath: c.repoDir,
    baseRef: baseSha,
    branch: c.branch,
    allowedFiles: order.scope.touches,
    tier0Paths: tier0,
    claimed: { head_sha: headSha },
  });
  if (!local.ok)
    throw new RunFailure(
      local.failure_class ?? 'no_artifact',
      `artifact guard: ${local.reason}${local.detail ? ` (${local.detail})` : ''}`,
    );
  const verifiedAt = nowIso(now());
  w.transaction((tx) => {
    tx.run(
      `INSERT INTO run_artifacts(run_id, kind, ref, sha, claimed_by_agent, verified_by_kernel, verified_at)
       VALUES (?, 'commit', ?, ?, 0, 1, ?)`,
      [runId, `${c.branch}@${headSha}`, headSha, verifiedAt],
    );
    tx.appendEvent({
      ...evBase(c),
      type: 'run.artifact_verified',
      idempotency_key: `${runId}+${c.branch}+${headSha}`,
      payload: { run_id: runId, artifact_kind: 'commit', ref: c.branch, sha: headSha, verified_by: 'kernel' },
    });
  });

  // ---- 9. evidence (outside the model) ----
  const probe = await runRowProbe(w, c.rowId, {
    repoDir: c.wm.pathFor(runId),
    target: 'branch',
    actor: { kind: 'system', id: SUPERVISOR.actor_id },
  });
  const probeAt = nowIso(now());
  const rowProbe = JSON.parse(getDbRow(w, c.rowId).probe_spec) as ProbeDefinition;
  const probeCmd = (rowProbe.command?.argv ?? []).join(' ');
  const checkCmds = [...new Set(order.acceptance.map((a) => a.probe_command.trim()))].filter(
    (cmd) => cmd.length > 0 && cmd !== probeCmd,
  );
  const checks: EvidenceInput['checks'] = [];
  for (const cmd of checkCmds) {
    const argv = cmd.split(/\s+/);
    const r = await executeCommandProbe(
      {
        ...rowProbe,
        command: { argv, cwd: '.', timeout_s: 600 },
        expected: { exit_code: 0 },
      },
      { cwd: c.wm.pathFor(runId) },
    );
    checks.push({
      argv,
      status: r.status === 'pass' ? 'pass' : 'fail',
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      ran_at: nowIso(now()),
    });
  }
  const diffText = await execOk(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      `${baseSha}...${headSha}`,
    ],
    { cwd: c.repoDir },
  );
  const diffPath = join(c.fwHome, 'runs', runId, 'diff.patch');
  writeFileSync(diffPath, diffText, { mode: 0o600 });
  const files = diffFileStats(diffText);
  const injected = result.injection_suspected ?? [];
  const provenance: EvidenceBundle['provenance'] = {
    untrusted_inputs: injected
      .slice(0, 50)
      .map((x) => ({ source: x.source, ref: `${stepsRef}#${x.location}` })),
    rule_of_two: {
      untrusted_input: injected.length > 0,
      sensitive_access: creds.used.length > 0,
      state_change_or_external_comms: true,
      score: (injected.length > 0 ? 1 : 0) + (creds.used.length > 0 ? 1 : 0) + 1,
    },
  };
  const evidenceInput: EvidenceInput = {
    id: newId('evb'),
    subject: { kind: 'pull_request', ref: runId, sha: headSha },
    code: c.rowCode,
    diff: { ref: relative(c.fwHome, diffPath), bytes: diffText, files },
    probe: {
      argv: rowProbe.command?.argv ?? [],
      status: probe.probe.status,
      exit_code: probe.probe.exit_code,
      duration_ms: probe.probe.duration_ms,
      result_id: probe.result_id,
      ran_at: probeAt,
    },
    checks,
    policy: { verdict, ran_at: policyAt },
    sandbox: { level: selftest.level, mode: selftest.mode, controls, checked_at: selftest.checked_at },
    adapter: { ...fingerprint, vendor: c.adapter.vendor, checked_at: fingerprintAt },
    cost: {
      usd: cost.usd,
      tokens_in: cost.input_tokens,
      tokens_out: cost.output_tokens,
      tokens_cached: cost.cached_tokens,
      estimated: cost.estimated,
    },
    provenance,
    now: nowIso(now()),
  };
  const built = buildEvidenceBundle(evidenceInput);
  const bundle = built.bundle;
  w.transaction((tx) => {
    tx.run(
      `INSERT INTO evidence_bundles(id, subject_kind, subject_ref, subject_sha, body, bundle_hash, scan_red, captured_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'kernel', ?)`,
      [
        bundle.id,
        bundle.subject.kind,
        bundle.subject.ref,
        headSha,
        canonicalJson(bundle),
        bundle.bundle_hash,
        built.scan_red ? 1 : 0,
        bundle.created_at,
      ],
    );
    tx.appendEvent({
      ...evBase(c),
      type: 'evidence.bundle_created',
      idempotency_key: bundle.id,
      payload: {
        bundle_id: bundle.id,
        subject_kind: bundle.subject.kind,
        subject_ref: bundle.subject.ref,
        subject_sha: headSha,
        bundle_hash: bundle.bundle_hash,
        scan_red: built.scan_red,
        ledger_row_id: c.rowId,
        diff_hash: built.diff_hash,
      },
    });
    if (built.scan_red)
      tx.appendEvent({
        ...evBase(c),
        type: 'evidence.scan_red_blocked',
        idempotency_key: `${bundle.id}+red`,
        payload: { bundle_id: bundle.id, failing_checks: built.failing },
      });
  });
  c.report.evidence_bundle_id = bundle.id;
  c.report.bundle_hash = bundle.bundle_hash;
  if (built.scan_red)
    throw new RunFailure(
      'claim_mismatch',
      `evidence is red (${built.failing.join(', ')}); no pull request opened`,
      {
        evidence_bundle_id: bundle.id,
      },
    );

  // ---- 10. push, PR, evidence comment ----
  const pushed = await c.host.pushBranch({ cwd: c.wm.pathFor(runId), branch: c.branch });
  if (pushed.sha !== headSha)
    throw new RunFailure('claim_mismatch', `pushed ${pushed.sha}, but the verified head is ${headSha}`);
  const pr = await c.host.openPullRequest({
    title: clip(`${c.rowCode}: ${c.rowTitle}`, 200),
    body: [
      `Ledger row ${c.rowCode}, work order \`${c.woId}\`, run \`${runId}\`.`,
      '',
      `Goal: ${order.goal}`,
      '',
      `Evidence bundle \`${bundle.id}\` (sha256 \`${bundle.bundle_hash}\`) is in the comment below.`,
      'Opened by FlowWeb. The Owner reviews and merges; `fw ledger close` finishes the row.',
    ].join('\n'),
    head: c.branch,
    base: c.prBase,
  });
  const comment = prComment({
    bundle,
    diff: { ref: evidenceInput.diff.ref, files },
    run_id: runId,
    probe: evidenceInput.probe,
    policy: verdict,
    checks,
    cost: evidenceInput.cost,
    sandbox: { level: selftest.level, mode: selftest.mode },
    adapter: { name: fingerprint.name, version: fingerprint.version },
  });
  const posted = await c.host.commentOnPr(pr.number, redactLiterals(comment, creds.literals));
  c.report.pr = { number: pr.number, url: pr.url, head_sha: pr.head_sha, comment_url: posted.url };

  // The PR pointer is re-fetched from the host and its head compared before anything counts.
  const remote = await checkRunArtifact({
    repoPath: c.repoDir,
    baseRef: baseSha,
    branch: c.branch,
    allowedFiles: order.scope.touches,
    tier0Paths: tier0,
    claimed: { head_sha: headSha, pr: { number: pr.number, url: pr.url } },
    host: c.host,
  });
  if (!remote.ok)
    throw new RunFailure(
      remote.failure_class ?? 'no_artifact',
      `pull request check: ${remote.reason}${remote.detail ? ` (${remote.detail})` : ''}`,
    );

  w.transaction((tx) => {
    const at = nowIso(now());
    tx.run(
      `INSERT INTO run_artifacts(run_id, kind, ref, sha, claimed_by_agent, verified_by_kernel, verified_at)
       VALUES (?, 'pull_request', ?, ?, 0, 1, ?)`,
      [runId, pr.url, headSha, at],
    );
    tx.appendEvent({
      ...evBase(c),
      type: 'run.artifact_verified',
      idempotency_key: `${runId}+${pr.url}+${headSha}`,
      payload: {
        run_id: runId,
        artifact_kind: 'pull_request',
        ref: pr.url,
        sha: headSha,
        verified_by: 'kernel',
      },
    });
    surfaceDbRefusal(() =>
      tx.run(
        "UPDATE runs SET status = 'succeeded', ended_at = ?, exit_code = 0 WHERE id = ? AND status = 'validating'",
        [at, runId],
      ),
    );
    tx.appendEvent({
      ...evBase(c),
      type: 'run.succeeded',
      idempotency_key: `${runId}+succeeded`,
      payload: {
        run_id: runId,
        artifact_count: 2,
        cost_usd: cost.usd,
        cost: costPayload,
        pr_url: pr.url,
        pr_number: pr.number,
        head_sha: headSha,
        comment_url: posted.url,
        evidence_bundle_id: bundle.id,
        bundle_hash: bundle.bundle_hash,
      },
    });
    tx.run("UPDATE work_orders SET status = 'completed' WHERE id = ? AND status = 'running'", [c.woId]);
    tx.appendEvent({
      ...evBase(c),
      type: 'work_order.completed',
      idempotency_key: `${c.woId}+${runId}`,
      payload: { work_order_id: c.woId, final_run_id: runId },
    });
    transitionRow(tx, c.rowId, 'verifying', {
      actor: { kind: 'system', id: SUPERVISOR.actor_id },
      guard_evidence: { run_id: runId, pr_url: pr.url, head_sha: headSha, evidence_bundle_id: bundle.id },
      set: { evidence_bundle_id: bundle.id },
    });
    releaseLeases(tx, getRun(tx, runId), 'run_succeeded', now);
  });
}

/** A claimed artifact counts only when the kernel can find it. */
async function verifyClaim(
  c: ExecCtx,
  a: { kind: string; ref: string; sha?: string },
): Promise<{ ok: boolean; detail: string }> {
  if (a.kind === 'pull_request') {
    const n = Number(/\/pull\/(\d+)\/?$/.exec(a.ref)?.[1] ?? Number.NaN);
    if (!Number.isSafeInteger(n)) return { ok: false, detail: 'not a pull request URL this host serves' };
    try {
      const pr = await c.host.getPrStatus(n);
      if (pr.url !== a.ref) return { ok: false, detail: `the host's pull request #${n} is ${pr.url}` };
      if (pr.head !== c.branch) return { ok: false, detail: `pull request #${n} is not from ${c.branch}` };
      return { ok: true, detail: 'found' };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  }
  if (a.kind === 'commit' && a.sha) {
    const sha = await refSha(c.repoDir, a.sha);
    const head = await refSha(c.repoDir, `refs/heads/${c.branch}`);
    if (!sha || !head) return { ok: false, detail: 'no such commit' };
    try {
      await git(c.repoDir, ['merge-base', '--is-ancestor', sha, head]);
      return { ok: true, detail: 'on the branch' };
    } catch {
      return { ok: false, detail: `commit ${sha} is not on ${c.branch}` };
    }
  }
  return { ok: false, detail: `the kernel cannot verify a claimed ${a.kind} artifact in C0` };
}

/** Quarantines the run branch and records why, then fails the run. */
async function quarantine(c: ExecCtx, verdict: DiffVerdict): Promise<never> {
  const q = await quarantineBranch({ repoPath: c.repoDir, branch: c.branch, run_id: c.runId });
  const tier0 = verdict.violations.filter((v) => v.rule === 'tier0_path').map((v) => v.path);
  const summary = verdict.violations.map((v) => `${v.rule} ${v.path}`).join(', ');
  c.w.transaction((tx) => {
    if (q.quarantined) tx.run('UPDATE runs SET branch = ? WHERE id = ?', [q.to, c.runId]);
    tx.appendEvent({
      ...evBase(c),
      actor_id: 'fwd.policy',
      type: 'policy.diff_policy_failed',
      idempotency_key: `${c.woId}+${verdict.diff_hash}+${c.runId}`,
      payload: {
        work_order_id: c.woId,
        run_id: c.runId,
        violations: verdict.violations,
        diff_hash: verdict.diff_hash,
        quarantine: q,
      },
    });
    if (tier0.length)
      tx.appendEvent({
        ...evBase(c),
        actor_id: 'fwd.policy',
        type: 'policy.tamper_tripwire_fired',
        idempotency_key: `${c.woId}+${verdict.diff_hash}+tier0_path`,
        payload: {
          run_id: c.runId,
          work_order_id: c.woId,
          paths: tier0,
          pattern: 'tier0_path',
          action: 'block',
          quarantined_branch: q.quarantined ? q.to : null,
        },
      });
  });
  if (q.quarantined) c.report.branch = q.to;
  throw new PolicyRefusal(
    'no_artifact',
    `diff policy violation (${summary}); branch ${q.quarantined ? `quarantined as ${q.to}` : `not quarantined: ${q.reason}`}, nothing pushed`,
    { violations: verdict.violations, quarantine: q },
  );
}
