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
import type { EvidenceBundle, LedgerRow, Probe, StreamDefinition, WorkOrder } from '@fw/contracts';

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
  finding_id?: string;
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
  /** The error code when a policy refused the run (DIFF_POLICY, KILL_SWITCH, BUDGET_EXHAUSTED), else null. */
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

/** The spend rollup groupings `fw spend --by` accepts. */
export const SPEND_GROUPS = ['agent', 'run', 'vendor', 'day', 'project'] as const;
export type SpendGroup = (typeof SPEND_GROUPS)[number];

/**
 * One group of the spend rollup (the same query as `GET /v1/spend`). The key column is named after
 * the group: agent_id, run_id, vendor, day or project_id. `usd` is null when the group has no spend
 * entries; `unknown_runs` counts the group's runs with no spend recorded (cost unknown, never 0).
 */
export interface SpendGroupRow {
  [key: string]: string | number | null | undefined;
  usd: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  entries: number;
  first_ts: string | null;
  last_ts: string | null;
  unknown_runs?: number;
}

export type ControlLevel = 'enforced' | 'best_effort' | 'absent';

/** `fw doctor`: the sandbox self-test a run would get, in this home. */
export interface DoctorReport {
  home: string;
  sandbox: {
    run_id: string;
    mode: string;
    platform: string;
    /** The weakest level across all controls. */
    level: ControlLevel;
    controls: Record<string, { level: ControlLevel; detail: string }>;
    child_env_keys: string[];
    notes: string[];
    checked_at: string;
  };
}

export interface GcEntry {
  run_id: string;
  path: string;
  /** null when the database has no such run. */
  status: string | null;
}

/** `fw gc`: run directories removed (terminal or unknown runs) and kept (active runs). */
export interface GcReport {
  home: string;
  removed: GcEntry[];
  kept: GcEntry[];
  skipped: { name: string; reason: string }[];
}

/**
 * `fw status`: the status strip of GET /v1/status when fwd answers (`daemon: "up"`), else the same
 * figures read from the database read-only (`daemon: "down"`, `started_at` null, `daemon_detail`
 * saying why fwd was not asked). `chain.head_seq` is the event log head either way.
 */
export interface StatusReport {
  [key: string]: unknown;
  daemon: 'up' | 'down';
  source: 'daemon' | 'database';
  home: string;
  database: boolean;
  started_at: string | null;
  version?: string;
  daemon_detail?: string;
  chain: {
    ok: boolean | null;
    head_seq: number | null;
    head_hash: string | null;
    verified_at: string | null;
    failed_seq: number | null;
  } | null;
  running_runs?: number;
  open_cards?: number;
  kill?: { engaged: boolean | null; reason: string | null } | null;
}

/** One stored stream (`fw stream list`). */
export interface StreamView {
  id: string;
  project_id: string;
  key: string;
  name: string;
  template: string;
  status: string;
  default_tier: string;
  version: number;
  wip_limit: number;
  trigger: string;
  budget: StreamDefinition['budget'];
  definition_hash: string;
  last_fired_at: string | null;
  created_at: string;
}

export interface StreamAddReport {
  stream: StreamView;
  approval_id: string | null;
  event_seq: number;
}

/** One project with its labels (`fw project list`). */
export interface ProjectView {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: string;
  repo_url: string | null;
  created_at: string;
  brand: string | null;
  category: string | null;
}

export interface ProjectLabelReport {
  project: ProjectView;
  changed_fields: ('brand' | 'category')[];
  event_seq: number | null;
}

/** FW-C-038: `fw project add`. */
export interface ProjectAddInput {
  slug: string;
  name?: string;
  kind?: string;
  brand?: string | null;
  category?: string | null;
}

export interface ProjectAddReport {
  project: ProjectView;
  event_seq: number;
}

/** FW-C-038: the Owner's answers to the five brief questions, word for word. */
export interface ProjectBrief {
  what: string;
  who: string;
  voice: string;
  never: string;
  done: string;
  updated_at: string;
}

export interface ProjectBriefReport {
  project: ProjectView;
  brief: ProjectBrief | null;
  event_seq: number | null;
}

export type SupervisorAction = 'pause' | 'resume' | 'enable' | 'disable';

/** GET /v1/supervisor, plus where it was read from (FW-C-033). */
export interface SupervisorReport {
  source: 'daemon' | 'database';
  kill_switch: boolean;
  paused: boolean;
  max_concurrent: number;
  running: number;
  gates: string[];
  flows: {
    key: string;
    name: string;
    enabled: boolean;
    /** FW-C-035: draft, copilot or autopilot. */
    dial?: string;
    tier: string;
    state: 'ready' | 'held' | 'running';
    gate: string | null;
    reason: string;
    open_asks: number;
    budget: Record<string, unknown> | null;
  }[];
  next: string[];
  changed?: boolean;
}

export interface PolicyCheckInput {
  action: string;
  environment: string;
  role?: string;
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  effect: string;
  rule_id: string | null;
  rule_version: number | null;
  tier: string | null;
  reason: string;
  source: string;
  trail: string[];
  policy_path: string;
}

export interface ReconcileReport {
  checked: number;
  changes: number;
  drift: { kind: string; external_ref: string; ledger_row_id: string | null }[];
  duration_ms: number;
}

export interface RelayPromptReport {
  run_id: string;
  work_order_id: string;
  prompt: string;
  prompt_hash: string;
  reused: boolean;
}

export interface RelayOwedReport {
  older_than_hours: number;
  owed: {
    run_id: string;
    work_order_id: string;
    ledger_row_id: string;
    queued_at: string;
    age_hours: number;
  }[];
  review_items: { run_id: string; card_id: string; created: boolean }[];
}

export interface RelayResultReport {
  run_id: string;
  result_hash: string;
  status: string;
  exit_code: number;
}

export interface PolicyApplyReport {
  rules_changed: string[];
  rules_unchanged: number;
  budgets_set: string[];
  budgets_unchanged: number;
  policy_path: string;
}

export interface CoreClient {
  /** fwd's status, or a read-only database read when fwd is down: optional, served by the daemon package. */
  status?(): Promise<StatusReport>;
  ledgerSync(opts?: { rowsDir?: string }): Promise<SyncReport>;
  ledgerList(opts?: { status?: string; lane?: string }): Promise<RowView[]>;
  ledgerShow(code: string): Promise<RowDetail>;
  ledgerNext(): Promise<{ row: RowView | null; retest_candidates: number }>;
  ledgerRetest(code: string, opts?: { repoDir?: string }): Promise<PremiseReport>;
  ledgerClose(code: string, opts: { mergedSha: string; repoDir?: string }): Promise<CloseReport>;
  woIssue(code: string, opts?: { doer?: string; verifier?: string; repoDir?: string }): Promise<IssueReport>;
  auditVerify(): Promise<VerifyResult>;
  /** Stream commands: optional, so a provider without the stream model still loads. */
  streamAdd?(definition: unknown, opts?: { approvalId?: string }): Promise<StreamAddReport>;
  streamList?(): Promise<StreamView[]>;
  /** Project commands: optional, so an older provider still loads. */
  projectList?(filter?: { brand?: string; category?: string }): Promise<ProjectView[]>;
  projectLabel?(
    ref: string,
    change: { brand?: string | null; category?: string | null },
  ): Promise<ProjectLabelReport>;
  projectAdd?(input: ProjectAddInput): Promise<ProjectAddReport>;
  /** With answers: save the brief (all five or nothing). Without: read it. */
  projectBrief?(ref: string, answers?: Record<string, string | undefined>): Promise<ProjectBriefReport>;
  /** Run commands: optional, because only a provider with the runtime (the daemon) serves them. */
  runStart?(code: string, opts?: RunStartOptions): Promise<RunStartReport>;
  runList?(opts?: { status?: string; limit?: number }): Promise<RunSummary[]>;
  runShow?(runId: string): Promise<RunDetail>;
  /** Spend rollup: optional, served by the provider that reads spend_entries (the daemon). */
  spendRollup?(opts: { by: SpendGroup }): Promise<SpendGroupRow[]>;
  /** Maintenance commands: optional for the same reason (the sandbox lives in the daemon). */
  doctor?(): Promise<DoctorReport>;
  gc?(): Promise<GcReport>;
  /** The Supervisor: optional, served by the daemon package. Controls need fwd up (CLI token). */
  supervisorStatus?(): Promise<SupervisorReport>;
  supervisorControl?(action: SupervisorAction, flow?: string): Promise<SupervisorReport>;
  /** FW-C-035: set a flow's dial; autopilot needs the confirm hash fwd names. */
  supervisorDial?(flow: string, stop: string, confirm?: string): Promise<SupervisorReport>;
  /** The policy engine: optional, served by the daemon package (the CLI never imports @fw/policy). */
  policyCheck?(input: PolicyCheckInput): Promise<PolicyDecision>;
  policyApply?(): Promise<PolicyApplyReport>;
  /** One git host reconcile pass: optional, served by the daemon package. */
  reconcile?(opts?: { host?: string }): Promise<ReconcileReport>;
  /** Relay R1: paste-ready prompts, owed prompts and pasted results; served by the daemon package. */
  relayPrompt?(order: string): Promise<RelayPromptReport>;
  relayOwed?(opts?: { olderThanHours?: number }): Promise<RelayOwedReport>;
  relayResult?(runId: string, text: string): Promise<RelayResultReport>;
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
