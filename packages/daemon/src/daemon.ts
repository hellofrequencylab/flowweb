// fwd composition root: FW_HOME layout, the single writer, the startup reconciler, the chain
// check, and the loopback HTTP API. bin.ts wraps this with flags, signals and exit codes.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore, type Store, type Writer } from '@fw/eventlog';
import { ApiError, sendError } from './api/http.ts';
import { buildRouter, principalOf } from './api/routes.ts';
import type { ChainStatus } from './api/status.ts';
import { hostAllowed, PairingStore, writeOriginAllowed } from './auth.ts';
import { type ReconcileReport, reconcileOnStart } from './reconciler.ts';

export const DEFAULT_PORT = 7317;
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
  ssePollMs?: number;
  sseHeartbeatMs?: number;
  log?: (line: string) => void;
  /** Test hook: runs after the reconciler and before the server listens. */
  beforeListen?: (writer: Writer) => void;
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
  /** The code printed for pairing on this start, if one is pending. */
  readonly pairingCode: string | undefined;
  readonly cliTokenPath: string;
  verifyChainNow(): ChainStatus;
  /** Appends system.stopped, ends streams, closes the server and the store. Idempotent. */
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

  // ---- auth --------------------------------------------------------------------------------
  const pairing = new PairingStore(join(fwHome, 'pairing'));
  const cliTokenPath = pairing.ensureCliToken();
  const devNoAuth = opts.devNoAuth === true;
  const pairingCode = devNoAuth ? undefined : pairing.ensurePairingCode(opts.forcePairingCode === true);

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
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!hostAllowed(req.headers.host, port)) {
      throw new ApiError(403, 'unauthorized', 'Host header must be 127.0.0.1 or localhost with the fwd port');
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${port}`);
    const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    if (!safe && !writeOriginAllowed(req, port)) {
      throw new ApiError(403, 'unauthorized', 'cross-origin writes are refused');
    }
    const m = router.match(method, url.pathname);
    if (m.kind === 'not_found') throw new ApiError(404, 'not_found', `no route ${method} ${url.pathname}`);
    if (m.kind === 'method_not_allowed') {
      throw new ApiError(405, 'not_found', `${method} is not allowed on ${url.pathname}`, { allow: m.allow });
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

  const stop = async (reason = 'stop requested'): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(chainTimer);
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
        payload: { reason, clean: true, boot_id: bootId },
      });
    } finally {
      store.close();
    }
  };

  return {
    fwHome,
    port,
    url: `http://${LOOPBACK}:${port}`,
    store,
    writer,
    bootId,
    startedAt,
    reconcile,
    pairingCode,
    cliTokenPath,
    verifyChainNow,
    stop,
  };
}
