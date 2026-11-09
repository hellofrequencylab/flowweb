// In-process core client of the daemon: the ledger's client (every ledger, work order and audit
// command) plus the run commands, which need the daemon's runtime. The CLI finds it through the
// `fw.coreClient` field of this package's package.json (priority 20, above the ledger's 10), so the
// CLI still imports only @fw/contracts. In C1 the same calls go over loopback HTTP to fwd.
// One process holds one writer lock: the run commands close the ledger client's store first.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openStore, type Store } from '@fw/eventlog';
import {
  createCoreClient as createLedgerClient,
  dbPath,
  LedgerError,
  type LocalClientOptions,
  type LocalCoreClient,
  resolveHome,
} from '@fw/ledger';
import { listRuns, type RunDetail, type RunSummary, showRun } from './pipeline/queries.ts';
import { type RunStartReport, runStart } from './pipeline/run-start.ts';
import { type DoctorReport, runDoctor } from './runtime/doctor.ts';
import { type GcReport, gcRunDirs } from './runtime/gc.ts';

export interface RunStartRequest {
  adapter?: string;
  scenario?: string;
  base?: string;
  host?: string;
  maxWallClockS?: number;
  repoDir?: string;
}

export interface DaemonCoreClient extends LocalCoreClient {
  runStart(code: string, opts?: RunStartRequest): Promise<RunStartReport>;
  runList(opts?: { status?: string; limit?: number }): Promise<RunSummary[]>;
  runShow(runId: string): Promise<RunDetail>;
  doctor(): Promise<DoctorReport>;
  gc(): Promise<GcReport>;
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
    async runStart(code, o = {}) {
      return runStart(open(true).writer!, code, {
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
    async doctor() {
      return runDoctor(home);
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
    close() {
      store?.close();
      store = undefined;
      ledger.close();
    },
  };
}
