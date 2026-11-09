// The CoreClient interface: every operation `fw` performs, as the daemon will serve it over loopback
// HTTP (docs/api/LOCAL-API-V1.md). The CLI depends only on @fw/contracts, so it never imports a kernel
// package. Until fwd serves these routes, an in-process provider stands in for the daemon: a workspace
// package that declares
//
//   "fw": { "coreClient": { "module": "./src/x.ts", "export": "createCoreClient", "priority": 10 } }
//
// in its package.json. The CLI finds providers at run time by reading the workspace manifests and
// loads the highest priority one with a dynamic import; FW_CORE_CLIENT (a module path) overrides the
// search. Nothing here names a provider package, so when the daemon declares a higher-priority
// provider it takes over without a CLI change.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvidenceBundle, LedgerRow, Probe, WorkOrder } from '@fw/contracts';

export type RowStatus = LedgerRow['status'];

export interface RowView {
  code: string;
  id: string;
  title: string;
  status: RowStatus;
  priority: string;
  size: string;
  lane: string;
  wave: string | null;
  owner: { kind: string; id: string };
  depends_on: string[];
  premise_valid: boolean | null;
  last_probe_status: string;
  last_probe_at: string | null;
  merged_sha: string | null;
  evidence_bundle_id: string | null;
  probe_hash: string;
  closed_at: string | null;
}

export interface SyncRefusal {
  code: string;
  reason: string;
  message: string;
  file?: string;
  id?: string;
  stored_hash?: string;
  file_hash?: string;
  cycle?: string[];
}

export interface SyncReport {
  applied: boolean;
  created: string[];
  unchanged: string[];
  refused: SyncRefusal[];
  drifted: { code: string; fields: string[] }[];
  graph: { rows: number; edges: number; acyclic: boolean; cycles: string[][] };
  project_id: string | null;
}

export interface ProbeEvidence {
  exit_code: number | null;
  output_tail: string;
  duration_ms: number;
}

export interface RowDetail {
  row: RowView;
  contract: LedgerRow;
  probe: Probe;
  evidence: {
    id: string;
    subject_sha: string | null;
    bundle_hash: string;
    created_at: string;
    bundle: EvidenceBundle;
    probe: ProbeEvidence | null;
  }[];
  work_orders: {
    id: string;
    version: number;
    status: string;
    doer_agent_id: string | null;
    expires_at: string | null;
  }[];
  events: { seq: number; ts: string; type: string; payload: Record<string, unknown> }[];
}

export interface PremiseReport {
  code: string;
  outcome: 'ready' | 'parked' | 'unchanged';
  still_valid: boolean | null;
  from: RowStatus;
  to: RowStatus;
  result_id: string;
  base_sha: string | null;
  probe: ProbeEvidence & { status: string; timed_out: boolean; error?: string };
}

export interface CloseReport {
  code: string;
  status: 'done';
  merged_sha: string;
  bundle_id: string;
  bundle_hash: string;
  result_id: string;
  probe: ProbeEvidence;
}

export interface IssueReport {
  code: string;
  work_order_id: string;
  version: number;
  content_hash: string;
  doer: string;
  verifier: string;
  expires_at: string;
  work_order: WorkOrder;
}

export type VerifyResult =
  | { ok: true; count: number; head: string }
  | { ok: false; seq: number; reason: string; count: number };

export interface RunStartOptions {
  /** fake | claude (default $FW_VENDOR, else claude). */
  adapter?: string;
  /** Fake adapter only. */
  scenario?: string;
  base?: string;
  /** gh | local | local:<bare repo path>. */
  host?: string;
  /** Tightens the work order's wall-clock cap, never loosens it. */
  maxWallClockS?: number;
  repoDir?: string;
}

export interface RunStartReport {
  code: string;
  ok: boolean;
  run_id: string | null;
  /** The run's final status, or `refused` when no run was started. */
  status: string;
  failure_class: string | null;
  reason: string | null;
  /** The error code when a policy refused the run's change (for example DIFF_POLICY), else null. */
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

export interface RunSummary {
  id: string;
  row: string;
  status: string;
  failure_class: string | null;
  adapter: string;
  attempt: number;
  branch: string | null;
  queued_at: string;
  ended_at: string | null;
  /** null when no spend was recorded (cost unknown). */
  cost_usd: number | null;
}

export interface RunDetail extends RunSummary {
  work_order_id: string;
  agent_id: string;
  workspace_path: string | null;
  started_at: string | null;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  exit_code: number | null;
  cost: { usd: number | null; entries: number; known: boolean };
  artifacts: { kind: string; ref: string; sha: string | null; verified_by_kernel: boolean }[];
  evidence: {
    id: string;
    bundle_hash: string;
    subject_sha: string | null;
    scan_red: boolean;
    created_at: string;
  }[];
  steps: number;
  events: { seq: number; ts: string; type: string; payload: Record<string, unknown> }[];
}

export interface CoreClient {
  ledgerSync(opts?: { rowsDir?: string }): Promise<SyncReport>;
  ledgerList(opts?: { status?: string; lane?: string }): Promise<RowView[]>;
  ledgerShow(code: string): Promise<RowDetail>;
  ledgerNext(): Promise<{ row: RowView | null; retest_candidates: number }>;
  ledgerRetest(code: string, opts?: { repoDir?: string }): Promise<PremiseReport>;
  ledgerClose(code: string, opts: { mergedSha: string; repoDir?: string }): Promise<CloseReport>;
  woIssue(code: string, opts?: { doer?: string; verifier?: string; repoDir?: string }): Promise<IssueReport>;
  auditVerify(): Promise<VerifyResult>;
  /** Run commands: optional, because only a provider with the runtime (the daemon) serves them. */
  runStart?(code: string, opts?: RunStartOptions): Promise<RunStartReport>;
  runList?(opts?: { status?: string; limit?: number }): Promise<RunSummary[]>;
  runShow?(runId: string): Promise<RunDetail>;
  close(): void;
}

export interface CoreClientOptions {
  home?: string;
  repoDir: string;
  project?: { slug?: string; name?: string };
}

export type CoreClientFactory = (opts: CoreClientOptions) => CoreClient;

/** A provider declaration found in a workspace package.json. */
export interface ProviderDecl {
  package: string;
  module: string;
  export: string;
  priority: number;
}

const METHODS = [
  'ledgerSync',
  'ledgerList',
  'ledgerShow',
  'ledgerNext',
  'ledgerRetest',
  'ledgerClose',
  'woIssue',
  'auditVerify',
  'close',
] as const;

export class ClientUnavailableError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

/** The workspace root: the nearest directory at or above start holding pnpm-workspace.yaml. */
export function findWorkspaceRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Every `fw.coreClient` declaration under <root>/packages/*, highest priority first. */
export function findProviders(root: string): ProviderDecl[] {
  const pkgs = join(root, 'packages');
  if (!existsSync(pkgs)) return [];
  const out: ProviderDecl[] = [];
  for (const name of readdirSync(pkgs).sort()) {
    const manifest = join(pkgs, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string;
      fw?: { coreClient?: { module?: unknown; export?: unknown; priority?: unknown } };
    };
    const decl = pkg.fw?.coreClient;
    if (!decl || typeof decl.module !== 'string') continue;
    out.push({
      package: pkg.name ?? name,
      module: resolve(pkgs, name, decl.module),
      export: typeof decl.export === 'string' ? decl.export : 'createCoreClient',
      priority: typeof decl.priority === 'number' ? decl.priority : 0,
    });
  }
  return out.sort((a, b) => b.priority - a.priority || a.package.localeCompare(b.package));
}

function checked(factory: unknown, where: string): CoreClientFactory {
  if (typeof factory !== 'function')
    throw new ClientUnavailableError(`${where} does not export a client factory`);
  return (opts) => {
    const client = (factory as CoreClientFactory)(opts);
    const missing = METHODS.filter(
      (m) => typeof (client as unknown as Record<string, unknown>)[m] !== 'function',
    );
    if (missing.length)
      throw new ClientUnavailableError(`${where} returned a client without ${missing.join(', ')}`);
    return client;
  };
}

/** Loads the core client factory: FW_CORE_CLIENT, else the highest-priority workspace provider. */
export async function loadCoreClientFactory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CoreClientFactory> {
  const override = env.FW_CORE_CLIENT;
  if (override) {
    const href = override.startsWith('file:')
      ? override
      : pathToFileURL(isAbsolute(override) ? override : resolve(override)).href;
    const mod = (await import(href)) as Record<string, unknown>;
    return checked(mod[env.FW_CORE_CLIENT_EXPORT ?? 'createCoreClient'], override);
  }
  const root = findWorkspaceRoot(import.meta.dirname);
  const provider = root ? findProviders(root)[0] : undefined;
  if (!provider)
    throw new ClientUnavailableError(
      'no core client: the daemon is not running and no workspace package declares fw.coreClient',
    );
  const mod = (await import(pathToFileURL(provider.module).href)) as Record<string, unknown>;
  return checked(mod[provider.export], `${provider.package} (${provider.module})`);
}
