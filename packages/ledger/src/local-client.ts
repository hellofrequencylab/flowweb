// In-process core client: the ledger library behind the interface the CLI calls (CoreClient in
// packages/cli/src/client.ts, matched structurally). The daemon will serve the same operations over
// loopback HTTP; until then the CLI discovers this module through the `fw.coreClient` field of this
// package's package.json, so the CLI never imports a kernel package.
// Read commands open the database read-only; write commands take the single writer lock.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openStore, type Store, type VerifyResult } from '@fw/eventlog';
import { type CloseReport, closeRow } from './close.ts';
import { LedgerError } from './errors.ts';
import { dbPath, resolveHome, resolveProject } from './home.ts';
import { type PremiseReport, retestPremise } from './premise.ts';
import {
  type LabelChange,
  type LabelReport,
  labelProject,
  listProjects,
  type ProjectFilter,
  type ProjectView,
} from './projects/labels.ts';
import {
  addProject,
  type BriefReport,
  briefProject,
  getBrief,
  type ProjectAdd,
  type ProjectAddReport,
} from './projects/projects.ts';
import { listRows, nextRow, type RowDetail, retestCandidates, showRow } from './queries.ts';
import type { RowView } from './rows.ts';
import { addStream, listStreams, type StreamAddReport, type StreamView } from './streams/streams.ts';
import { type SyncReport, syncRows } from './sync.ts';
import { type IssueReport, issueWorkOrder } from './workorder/issue.ts';

export interface LocalClientOptions {
  /** FW_HOME; default $FW_HOME or ~/.flowweb. */
  home?: string;
  /** The repository checkout commands act on (row files, probes, policy). */
  repoDir: string;
  project?: { slug?: string; name?: string };
}

export interface LocalCoreClient {
  readonly home: string;
  readonly dbPath: string;
  ledgerSync(opts?: { rowsDir?: string }): Promise<SyncReport>;
  ledgerList(opts?: { status?: string; lane?: string }): Promise<RowView[]>;
  ledgerShow(code: string): Promise<RowDetail>;
  ledgerNext(): Promise<{ row: RowView | null; retest_candidates: number }>;
  ledgerRetest(code: string, opts?: { repoDir?: string }): Promise<PremiseReport>;
  ledgerClose(code: string, opts: { mergedSha: string; repoDir?: string }): Promise<CloseReport>;
  woIssue(code: string, opts?: { doer?: string; verifier?: string; repoDir?: string }): Promise<IssueReport>;
  auditVerify(): Promise<VerifyResult>;
  streamAdd(definition: unknown, opts?: { approvalId?: string }): Promise<StreamAddReport>;
  streamList(): Promise<StreamView[]>;
  projectList(filter?: ProjectFilter): Promise<ProjectView[]>;
  projectLabel(ref: string, change: LabelChange): Promise<LabelReport>;
  /** FW-C-039: a project with no repository. */
  projectAdd(input: ProjectAdd): Promise<ProjectAddReport>;
  /** FW-C-039: with answers, saves the brief (all five or nothing); without, reads it. */
  projectBrief(ref: string, answers?: Record<string, string | undefined>): Promise<BriefReport>;
  close(): void;
}

export function createCoreClient(opts: LocalClientOptions): LocalCoreClient {
  const home = resolveHome(opts.home);
  const path = dbPath(home);
  const repoDir = resolve(opts.repoDir);
  let store: Store | undefined;
  let readonly = true;

  const open = (write: boolean): Store => {
    if (store && (!write || !readonly)) return store;
    store?.close();
    if (!write && !existsSync(path))
      throw new LedgerError('NO_DATABASE', `no ledger database at ${path} (run fw ledger sync first)`);
    mkdirSync(dirname(path), { recursive: true });
    // One writer lock for the CLI and fwd: the same file fwd takes, so they can never both write.
    store = openStore({ path, readonly: !write, lockPath: join(home, 'fwd.lock') });
    readonly = !write;
    return store;
  };
  const writer = () => open(true).writer!;
  const reader = () => open(false).reader();

  return {
    home,
    dbPath: path,
    async ledgerSync(o = {}) {
      return syncRows(writer(), {
        rowsDir: resolve(o.rowsDir ?? resolve(repoDir, 'ledger', 'rows')),
        project: resolveProject(home, repoDir, opts.project),
      });
    },
    async ledgerList(o = {}) {
      return listRows(reader(), o);
    },
    async ledgerShow(code) {
      return showRow(reader(), code);
    },
    async ledgerNext() {
      const r = reader();
      return { row: nextRow(r), retest_candidates: retestCandidates(r) };
    },
    async ledgerRetest(code, o = {}) {
      return retestPremise(writer(), code, { repoDir: resolve(o.repoDir ?? repoDir) });
    },
    async ledgerClose(code, o) {
      return closeRow(writer(), code, { mergedSha: o.mergedSha, repoDir: resolve(o.repoDir ?? repoDir) });
    },
    async woIssue(code, o = {}) {
      const dir = resolve(o.repoDir ?? repoDir);
      return issueWorkOrder(writer(), code, {
        repoDir: dir,
        home,
        ...(o.doer !== undefined ? { doer: o.doer } : {}),
        ...(o.verifier !== undefined ? { verifier: o.verifier } : {}),
      });
    },
    async auditVerify() {
      return open(false).verifyChain();
    },
    async streamAdd(definition, o = {}) {
      return addStream(writer(), definition, o.approvalId ? { approvalId: o.approvalId } : {});
    },
    async streamList() {
      return listStreams(reader());
    },
    async projectList(filter = {}) {
      return listProjects(reader(), filter);
    },
    async projectLabel(ref, change) {
      return labelProject(writer(), ref, change);
    },
    async projectAdd(input) {
      return addProject(writer(), input);
    },
    async projectBrief(ref, answers) {
      return answers ? briefProject(writer(), ref, answers) : getBrief(reader(), ref);
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
}
