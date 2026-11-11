// fwd composition root: FW_HOME layout, the single writer, the startup reconciler, the chain
// check, and the loopback HTTP API. bin.ts wraps this with flags, signals and exit codes.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore, type Store, type Writer } from '@fw/eventlog';
import {
  addProject,
  briefProject,
  closeRow,
  expireDecisionItems,
  labelProject,
  type ProjectAdd,
  parkRow,
} from '@fw/ledger';
import { ApiError, sendError } from './api/http.ts';
import { buildRouter, principalOf, type RunStartBody } from './api/routes.ts';
import type { ChainStatus } from './api/status.ts';
import { hostAllowed, PairingStore, writeOriginAllowed } from './auth.ts';
import { syncAll as syncCrm } from './flows/crm.ts';
import { refreshQuietly as refreshLeads } from './flows/leads.ts';
import { loadFlow as loadNaFlow, FLOW_KEY as NA_KEY } from './flows/neighborhood-activation.ts';
import { pullOutcomes } from './flows/outcomes.ts';
import { loadFlow as loadAdsFlow } from './flows/paid-ads.ts';
import { ga4Of, pullDue, pullGa4, readPullStatus } from './flows/paid-ads-ga4.ts';
import { runReview } from './flows/review.ts';
import { batchApprove } from './flows/sequence.ts';
import { reapOrphanCycles, runFlowCycle } from './overseer/cycle.ts';
import { approveDraft, rejectDraft } from './overseer/drafts.ts';
import {
  createSupervisorOnFire,
  SupervisorError,
  setDial,
  setFlowAi,
  setFlowEnabled,
  setIntensity,
  setPaused,
  setSchedule,
  shippedFlows,
} from './overseer/index.ts';
import { rewriteDraft } from './overseer/rewrite.ts';
import { runStart } from './pipeline/run-start.ts';
import { type ReconcileReport, reconcileOnStart } from './reconciler.ts';
import { RunHost } from './run-host.ts';
import { createScheduler, type OnFire, type Scheduler } from './scheduler/index.ts';
import {
  DIGEST_STREAM_KEY,
  digestDue,
  digestStreams,
  publishForStream,
  registerDigestStreams,
} from './streams/digest/index.ts';

export const DEFAULT_PORT = 7317;
/** How long a stop waits for interrupted runs to be recorded before it gives up (clean: false). */
export const DEFAULT_STOP_TIMEOUT_MS = 20_000;
export const LOOPBACK = '127.0.0.1';
export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const VERSION: string = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }
).version;

export const HOME_DIRS = ['db', 'worktrees', 'runs', 'pairing'] as const;

/** Creates $FW_HOME and its directories with mode 0700. */
export function ensureFwHome(fwHome: string): void {
  mkdirSync(fwHome, { recursive: true, mode: 0o700 });
  chmodSync(fwHome, 0o700);
  for (const d of HOME_DIRS) {
    const p = join(fwHome, d);
    mkdirSync(p, { recursive: true, mode: 0o700 });
    chmodSync(p, 0o700);
  }
}

export interface DaemonOptions {
  fwHome: string;
  /** 0 picks a free port. */
  port: number;
  /** Disables pairing and token checks (FW_DEV_NO_AUTH=1). The Host guard stays on. */
  devNoAuth?: boolean;
  /** Print a fresh pairing code even when one was used before. */
  forcePairingCode?: boolean;
  chainVerifyIntervalMs?: number;
  /** How often decision items past their deadline are expired (default 60 s; also once at start). */
  decisionExpiryIntervalMs?: number;
  /** How often to check whether a paid-ads Google Analytics pull is due. Default 10 minutes. */
  adsPullCheckMs?: number;
  ssePollMs?: number;
  sseHeartbeatMs?: number;
  log?: (line: string) => void;
  /** How long stop() waits for in-flight runs to end (default DEFAULT_STOP_TIMEOUT_MS). */
  stopTimeoutMs?: number;
  /** Test hook: runs after the reconciler and before the server listens. */
  beforeListen?: (writer: Writer) => void;
  /** Admits or holds each stream fire. Default: every fire is admitted. */
  onFire?: OnFire;
}

export interface Daemon {
  readonly fwHome: string;
  readonly port: number;
  readonly url: string;
  readonly store: Store;
  readonly writer: Writer;
  readonly bootId: string;
  readonly startedAt: string;
  readonly reconcile: ReconcileReport;
  /** Fires cron streams on schedule and records every fire, missed and held ones included. */
  readonly scheduler: Scheduler;
  /** The code printed for pairing on this start, if one is pending. */
  readonly pairingCode: string | undefined;
  readonly cliTokenPath: string;
  verifyChainNow(): ChainStatus;
  /** The runs fwd hosts (POST /v1/runs). */
  readonly runs: RunHost;
  /**
   * Stops taking runs, interrupts the ones in flight (each is killed and recorded as ended with an
   * "interrupted" terminal event), then appends system.stopped, ends streams, closes the server and
   * the store. Idempotent.
   */
  stop(reason?: string): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`fwd: ${l}\n`));
  const fwHome = resolve(opts.fwHome);
  ensureFwHome(fwHome);

  // THE single writer. A second fwd on the same FW_HOME throws WriterLockError here.
  const store = openStore({ path: join(fwHome, 'db', 'fw.sqlite'), lockPath: join(fwHome, 'fwd.lock') });
  const writer = store.writer!;
  const bootId = randomBytes(8).toString('hex');
  const host_id = hostname();
  const startedAt = new Date().toISOString();

  let stopped = false;
  try {
    const schemaVersion =
      writer.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")?.value ??
      null;
    const genesis = writer.get('SELECT 1 FROM events LIMIT 1') === undefined;
    writer.appendEvent({
      type: 'system.started',
      actor_kind: 'system',
      actor_id: 'fwd',
      idempotency_key: `${host_id}:${bootId}`,
      payload: { kernel_version: VERSION, schema_version: schemaVersion, host_id, boot_id: bootId, genesis },
    });
  } catch (e) {
    store.close();
    throw e;
  }

  let reconcile: ReconcileReport;
  try {
    reconcile = reconcileOnStart(writer, { bootId });
  } catch (e) {
    store.close();
    throw e;
  }
  if (reconcile.runs_failed.length + reconcile.leases_released.length + reconcile.leases_expired.length > 0) {
    log(
      `reconciler: failed ${reconcile.runs_failed.length} orphaned run(s), released ${reconcile.leases_released.length} lease(s), expired ${reconcile.leases_expired.length} lease(s)`,
    );
  }
  // FW-C-045: a flow cycle is not a ledger run, so the reconciler does not see one a crash interrupted.
  try {
    reapOrphanCycles(writer, REPO_ROOT, fwHome, log);
  } catch (e) {
    log(`supervisor: reaping orphaned cycles failed: ${(e as Error)?.message ?? e}`);
  }
  opts.beforeListen?.(writer);

  // ---- chain check, cached ---------------------------------------------------------------
  let chain: ChainStatus = { ok: null, head_seq: null, head_hash: null, verified_at: null, failed_seq: null };
  const verifyChainNow = (): ChainStatus => {
    const v = store.verifyChain();
    const verified_at = new Date().toISOString();
    if (v.ok) {
      chain = {
        ok: true,
        head_seq: v.count,
        head_hash: v.count > 0 ? v.head : null,
        verified_at,
        failed_seq: null,
      };
    } else {
      chain = { ok: false, head_seq: v.count, head_hash: null, verified_at, failed_seq: v.seq };
      log(`chain verification FAILED at seq ${v.seq}: ${v.reason}`);
      try {
        writer.appendEvent({
          type: 'audit.chain_verification_failed',
          actor_kind: 'system',
          actor_id: 'fwd',
          idempotency_key: `events:${v.seq}`,
          payload: { chain: 'events', first_bad_seq: v.seq, reason: v.reason },
        });
      } catch (e) {
        log(`could not record the chain failure: ${(e as Error).message}`);
      }
    }
    return chain;
  };
  verifyChainNow();
  const chainTimer = setInterval(
    () => {
      try {
        verifyChainNow();
      } catch (e) {
        log(`chain verification error: ${(e as Error).message}`);
      }
    },
    opts.chainVerifyIntervalMs ?? 5 * 60_000,
  );
  chainTimer.unref();

  // ---- decision items past their deadline -----------------------------------------------
  const expireDecisions = (): void => {
    try {
      const expired = expireDecisionItems(writer);
      if (expired.length > 0) log(`decisions: expired ${expired.length} item(s) past their deadline`);
    } catch (e) {
      log(`decision expiry error: ${(e as Error).message}`);
    }
  };
  expireDecisions();
  const decisionTimer = setInterval(expireDecisions, opts.decisionExpiryIntervalMs ?? 60_000);
  decisionTimer.unref();

  // ---- paid ads: pull the campaign's daily numbers from Google Analytics (FW-C-058) ---------
  // Only when the flow's config names a GA4 property and credential. A failed pull is written to
  // the flow's pull status (shown on the Flows page) and logged; it never stops the daemon.
  const pullAds = async (): Promise<void> => {
    try {
      const f = loadAdsFlow(REPO_ROOT, fwHome);
      const g = f && ga4Of(f.cfg);
      if (!g) return;
      if (!pullDue(readPullStatus(fwHome), g, Date.now())) return;
      const s = await pullGa4(g, fwHome, {
        ...(process.env.FW_GA4_TOKEN_URL ? { tokenUrl: process.env.FW_GA4_TOKEN_URL } : {}),
        ...(process.env.FW_GA4_API_BASE ? { apiBase: process.env.FW_GA4_API_BASE } : {}),
      });
      log(
        s.ok
          ? `paid-ads: pulled ${s.days} day(s) from Google Analytics`
          : `paid-ads: pull failed: ${s.error}`,
      );
    } catch (e) {
      log(`paid-ads: pull error: ${(e as Error).message}`);
    }
  };
  void pullAds();
  const adsTimer = setInterval(() => void pullAds(), opts.adsPullCheckMs ?? 10 * 60_000);
  adsTimer.unref();
  // ---- flow outcomes (FW-C-055) -------------------------------------------------------------
  // Soon after start, then once a day: ask Frequency what became of the people the flow reached.
  const pullNow = (): void => {
    pullOutcomes({ repoRoot: REPO_ROOT, fwHome, env: process.env }).then(
      (n) => log(`outcomes: pulled ${n.outcomes} outcome row(s) and ${n.regions} region(s) from Frequency`),
      (e) => log(`outcomes: pull failed: ${(e as Error)?.message ?? e}`),
    );
    // FW-C-065: and tell Frequency's CRM where each lead is, which also picks up who signed up.
    syncCrm({ repoRoot: REPO_ROOT, fwHome, env: process.env }).then(
      (n) => {
        if (n.synced + n.failed > 0) log(`crm: ${n.synced} lead(s) synced to Frequency, ${n.failed} failed`);
      },
      (e) => log(`crm: sync failed: ${(e as Error)?.message ?? e}`),
    );
    // FW-C-103: once a day, rescore the lead graph so timing decays and new links count.
    refreshLeads(fwHome, NA_KEY, () => loadNaFlow(REPO_ROOT, fwHome)?.cfg.leads, log);
  };
  const everyMs = Number(process.env.FW_OUTCOMES_PULL_EVERY_MS) || 86_400_000;
  const firstPull = setTimeout(pullNow, 2_000);
  firstPull.unref();
  const pullTimer = setInterval(pullNow, everyMs);
  pullTimer.unref();
  // ---- weekly review (FW-C-056) ---------------------------------------------------------------
  // Scores the flow's hunts and shifts effort toward what works, as far as the dial allows.
  const reviewNow = (): void => {
    try {
      const r = runReview({ reader: writer, repoRoot: REPO_ROOT, fwHome });
      log(
        `review: ${r.shifts.length} shift(s), ${r.auto_apply ? 'applied at Autopilot' : 'waiting for the Owner'}`,
      );
    } catch (e) {
      log(`review: failed: ${(e as Error)?.message ?? e}`);
    }
  };
  const reviewTimer = setInterval(reviewNow, Number(process.env.FW_REVIEW_EVERY_MS) || 7 * 86_400_000);
  reviewTimer.unref();

  // ---- auth --------------------------------------------------------------------------------
  const pairing = new PairingStore(join(fwHome, 'pairing'));
  const cliTokenPath = pairing.ensureCliToken();
  const devNoAuth = opts.devNoAuth === true;
  const pairingCode = devNoAuth ? undefined : pairing.ensurePairingCode(opts.forcePairingCode === true);

  // ---- runs --------------------------------------------------------------------------------
  const runs = new RunHost();
  const startRun = (b: RunStartBody, signal: AbortSignal) =>
    runStart(writer, b.code, {
      home: fwHome,
      repoDir: b.repo_dir,
      signal,
      ...(b.adapter !== undefined ? { adapter: b.adapter } : {}),
      ...(b.scenario !== undefined ? { scenario: b.scenario } : {}),
      ...(b.base !== undefined ? { base: b.base } : {}),
      ...(b.host !== undefined ? { host: b.host } : {}),
      ...(b.max_wall_clock_s !== undefined ? { maxWallClockS: b.max_wall_clock_s } : {}),
    });

  // ---- http --------------------------------------------------------------------------------
  const streams = new Set<() => void>();
  let port = 0;
  const router = buildRouter({
    reader: store.reader(),
    fwHome,
    repoRoot: REPO_ROOT,
    version: VERSION,
    startedAt,
    chain: () => chain,
    pairing,
    ssePollMs: opts.ssePollMs ?? 250,
    sseHeartbeatMs: opts.sseHeartbeatMs ?? 15_000,
    trackStream: (end) => {
      streams.add(end);
      return () => streams.delete(end);
    },
    runs: { host: runs, start: startRun },
    supervisor: {
      setFlowEnabled: (key, enabled) => setFlowEnabled(writer, REPO_ROOT, key, enabled),
      setPaused: (paused) => setPaused(writer, paused),
      setDial: (key, stop, confirm) => setDial(writer, REPO_ROOT, fwHome, key, stop, confirm),
      // FW-C-063: a moved cron reloads the scheduler, so the next fire is at the new time.
      setSchedule: (key, time, days) => {
        const out = setSchedule(writer, REPO_ROOT, key, time, days);
        if (out.rescheduled) reloadScheduler();
        return out;
      },
      setIntensity: (key, body) => setIntensity(writer, REPO_ROOT, key, body),
      setFlowAi: (key, body) => setFlowAi(REPO_ROOT, fwHome, key, body),
      approveDraft: (key, id) => approveDraft({ writer, repoRoot: REPO_ROOT, fwHome, flow: key, id }),
      rejectDraft: (key, id) => rejectDraft({ repoRoot: REPO_ROOT, fwHome, flow: key, id }),
      batchApprove: (key, draftIds) =>
        batchApprove({ writer, repoRoot: REPO_ROOT, fwHome, flow: key, draftIds }),
      rewriteDraft: (key, id, body) =>
        rewriteDraft(
          { writer, repoRoot: REPO_ROOT, fwHome, env: process.env, log },
          { flow: key, id, instruction: body.instruction, subject: body.subject, body: body.body },
        ),
      runFlow: async (key) => {
        const s = writer.get<{ id: string }>('SELECT id FROM streams WHERE key = ?', [key]);
        if (!s || !shippedFlows(REPO_ROOT).some((f) => f.key === key))
          throw new SupervisorError(
            'NOT_FOUND',
            `no flow named ${key} with a registered stream (turn it on first)`,
          );
        const rec = await scheduler.fireNow(s.id);
        return { fire_id: rec.fire_id, outcome: rec.outcome, ...(rec.reason ? { reason: rec.reason } : {}) };
      },
      inFlight: () => inFlight(),
    },
    projects: {
      add: (input) => addProject(writer, input as unknown as ProjectAdd),
      label: (ref, change) => labelProject(writer, ref, change),
      brief: (ref, answers) => briefProject(writer, ref, answers),
    },
    ledger: {
      close: (code, mergedSha, repoDir) => closeRow(writer, code, { mergedSha, repoDir }),
      park: async (code, reason) => parkRow(writer, code, { reason }),
    },
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!hostAllowed(req.headers.host, port)) {
      throw new ApiError(403, 'forbidden', 'Host header must be 127.0.0.1 or localhost with the fwd port');
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${port}`);
    const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    if (!safe && !writeOriginAllowed(req, port)) {
      throw new ApiError(403, 'forbidden', 'cross-origin writes are refused');
    }
    const m = router.match(method, url.pathname);
    if (m.kind === 'not_found') throw new ApiError(404, 'not_found', `no route ${method} ${url.pathname}`);
    if (m.kind === 'method_not_allowed') {
      throw new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${url.pathname}`, {
        allow: m.allow,
      });
    }
    if (url.pathname !== '/v1/pair') {
      const principal = devNoAuth ? ({ kind: 'dev_no_auth' } as const) : pairing.authenticate(req);
      if (!principal) {
        throw new ApiError(
          401,
          'unauthorized',
          'pair this browser first (POST /v1/pair) or send the CLI token',
        );
      }
      principalOf.set(req, principal);
    }
    const out = await m.handler({ req, res, params: m.params, query: url.searchParams });
    if (out !== undefined && !res.headersSent) {
      const text = JSON.stringify(out);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      res.end(method === 'HEAD' ? undefined : text);
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError(500, 'internal', 'internal error', { reason: (e as Error)?.message ?? String(e) });
      if (err.status >= 500 && !(e instanceof ApiError)) log(`internal error: ${(e as Error)?.stack ?? e}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err, err.status === 405 ? { allow: String(err.details.allow ?? '') } : {});
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 0; // SSE responses are long-lived

  try {
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(opts.port, LOOPBACK, () => {
        server.off('error', fail);
        ok();
      });
    });
  } catch (e) {
    clearInterval(chainTimer);
    clearInterval(decisionTimer);
    clearInterval(adsTimer);
    clearInterval(pullTimer);
    clearTimeout(firstPull);
    clearInterval(reviewTimer);
    try {
      writer.appendEvent({
        type: 'system.stopped',
        actor_kind: 'system',
        actor_id: 'fwd',
        idempotency_key: `${host_id}:${bootId}:stop`,
        payload: { reason: `listen failed: ${(e as Error).message}`, clean: false, boot_id: bootId },
      });
    } finally {
      store.close();
    }
    throw e;
  }
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : opts.port;

  // FW-C-036: by default the Supervisor decides every fire of a flow (a hold names its gate).
  // FW-C-097: cycles in flight count as running, so a second fire waits at the flow's wip limit.
  const supervise = createSupervisorOnFire({
    reader: writer,
    repoRoot: REPO_ROOT,
    fwHome,
    inFlight: () => inFlight(),
  });
  // FW-C-038: an admitted fire of a flow runs one cycle, after the fire is recorded.
  const onFire: OnFire =
    opts.onFire ??
    (async (f) => {
      const v = await supervise(f);
      // FW-C-061: an admitted fire of a digest stream publishes that project's digest.
      if (v.outcome === 'admit' && f.streamKey === DIGEST_STREAM_KEY)
        setImmediate(() => {
          if (stopped) return;
          try {
            const r = publishForStream(writer, f.streamId, f.dueAt);
            if (r && !r.published)
              log(`digest: not published, it failed its check (${r.problems.length} problem(s))`);
          } catch (e) {
            log(`digest: publish failed: ${(e as Error)?.message ?? e}`);
          }
        });
      if (v.outcome === 'admit' && shippedFlows(REPO_ROOT).some((x) => x.key === f.streamKey))
        setImmediate(() => {
          if (stopped) return;
          const ac = new AbortController();
          const done = runFlowCycle(
            { writer, repoRoot: REPO_ROOT, fwHome, env: process.env, log, signal: ac.signal },
            { flow: f.streamKey, streamId: f.streamId, fireId: f.fireId },
          ).finally(() => cycles.delete(entry));
          const entry = { flow: f.streamKey, ac, done };
          cycles.add(entry);
        });
      return v;
    });
  const scheduler = createScheduler({ writer, log, onFire });
  /** FW-C-063: re-reads every stream's cron. A failed reload is logged, never swallowed. */
  const reloadScheduler = (): void => {
    if (stopped) return;
    void scheduler
      .stop()
      .then(() => (stopped ? undefined : scheduler.start()))
      .then(() => log('scheduler: reloaded after a schedule change'))
      .catch((e) => log(`scheduler: reload failed: ${(e as Error)?.message ?? e}`));
  };
  /** Flow cycles in flight: a stop kills each one and waits for its report before closing the store. */
  const cycles = new Set<{ flow: string; ac: AbortController; done: Promise<void> }>();
  /** FW-C-097: the cycles above, counted by flow key. GET /v1/supervisor reports them as running. */
  const inFlight = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of cycles) out[c.flow] = (out[c.flow] ?? 0) + 1;
    return out;
  };

  const stop = async (reason = 'stop requested'): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // No new fires once a stop has begun.
    await scheduler.stop();
    // Runs first: each one in flight is killed and recorded before system.stopped is written.
    const drained = await runs.drain(
      `interrupted: fwd stopping (${reason})`,
      opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    );
    if (!drained.settled)
      log(
        `stop: ${drained.interrupted} run(s) did not end in time; the reconciler fails them on the next start`,
      );
    else if (drained.interrupted > 0) log(`stop: interrupted ${drained.interrupted} run(s)`);
    if (cycles.size > 0) {
      const pending = [...cycles];
      for (const c of pending) c.ac.abort(`fwd stopping (${reason})`);
      const timeout = new Promise<'timeout'>((ok) =>
        setTimeout(() => ok('timeout'), opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS).unref(),
      );
      const end = await Promise.race([
        Promise.all(pending.map((c) => c.done)).then(() => 'ok' as const),
        timeout,
      ]);
      log(
        `stop: interrupted ${pending.length} flow cycle(s)${end === 'timeout' ? ', not all ended in time' : ''}`,
      );
    }
    clearInterval(chainTimer);
    clearInterval(decisionTimer);
    clearInterval(adsTimer);
    clearInterval(pullTimer);
    clearTimeout(firstPull);
    clearInterval(reviewTimer);
    for (const end of [...streams]) end();
    await new Promise<void>((ok) => {
      server.close(() => ok());
      server.closeAllConnections();
    });
    try {
      writer.appendEvent({
        type: 'system.stopped',
        actor_kind: 'system',
        actor_id: 'fwd',
        idempotency_key: `${host_id}:${bootId}:stop`,
        payload: { reason, clean: drained.settled, boot_id: bootId, runs_interrupted: drained.interrupted },
      });
    } finally {
      store.close();
    }
  };

  try {
    // FW-C-061: every project with a ledger gets its daily digest stream before the timers are armed.
    registerDigestStreams(writer, { log });
    await scheduler.start();
  } catch (e) {
    await stop(`scheduler failed to start: ${(e as Error).message}`);
    throw e;
  }
  // A digest missed while fwd was off or asleep is published now, not tomorrow.
  for (const s of digestStreams(writer))
    if (digestDue(writer, s))
      scheduler
        .fireNow(s.id, { ref: 'catch-up' })
        .catch((e) => log(`digest: catch-up fire failed: ${(e as Error)?.message ?? e}`));

  return {
    fwHome,
    port,
    url: `http://${LOOPBACK}:${port}`,
    store,
    writer,
    bootId,
    startedAt,
    reconcile,
    scheduler,
    pairingCode,
    cliTokenPath,
    verifyChainNow,
    runs,
    stop,
  };
}
