// Adapter SDK types.
//
// The contract types below (VendorAdapterInput, WorkOrder, RunResult and their parts) mirror
// contracts-core/json-schema/vendor-adapter-input.json, work-order.json, run-result.json and
// common.json field for field. They are a stopgap: they will be replaced by the types generated
// in @fw/contracts once that package lands. Do not add fields here that the schemas do not have.

// ---------------------------------------------------------------------------
// common.json
// ---------------------------------------------------------------------------

export type Vendor = 'anthropic' | 'openai' | 'google' | 'local' | 'other';
export type Tier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type Environment = 'sandbox' | 'staging' | 'production';
export type ActionClass =
  | 'read_research'
  | 'code_write_sandbox'
  | 'merge_main'
  | 'deploy_production'
  | 'prod_db_migration'
  | 'outbound_email_external'
  | 'outbound_email_known_template'
  | 'support_reply_new_category'
  | 'support_reply_sensitive'
  | 'support_reply_faq'
  | 'spend_money'
  | 'security_remediation'
  | 'security_remediation_patch_bump'
  | 'scheduling_external'
  | 'scheduling_own'
  | 'publish_external'
  | 'incident_runbook_reversible'
  | 'incident_data_change'
  | 'config_secrets_iam_dns_billing'
  | 'memory_write'
  | 'skill_promote'
  | 'instruction_edit'
  | 'policy_or_gate_change'
  | 'goal_propose'
  | 'goal_verification_change';

export type ArtifactKind =
  | 'pull_request'
  | 'commit'
  | 'message_id'
  | 'file'
  | 'report'
  | 'deploy'
  | 'calendar_hold'
  | 'ticket_reply'
  | 'email_draft';

/** common.json#/$defs/budget_caps. At least one property must be present. */
export interface BudgetCaps {
  max_usd?: number;
  max_tokens?: number;
  max_minutes?: number;
  max_turns?: number;
}

/** common.json#/$defs/artifact_pointer */
export interface ArtifactPointer {
  kind: ArtifactKind;
  ref: string;
  sha?: string;
  title?: string;
}

/** common.json#/$defs/rule_of_two */
export interface RuleOfTwo {
  untrusted_input: boolean;
  sensitive_access: boolean;
  state_change_or_external_comms: boolean;
  score: number;
  inputs_hash?: string;
}

/** common.json#/$defs/provenance */
export interface Provenance {
  untrusted_inputs: Array<{ source: string; ref: string; ingested_at?: string }>;
  rule_of_two: RuleOfTwo;
}

/** common.json#/$defs/injection_suspected */
export type InjectionSuspected = Array<{ source: string; fragment: string; location: string }>;

// ---------------------------------------------------------------------------
// work-order.json
// ---------------------------------------------------------------------------

export interface WorkOrder {
  id: string;
  version: number;
  title: string;
  project_id: string;
  stream_id: string;
  ledger_row_id: string;
  base_commit: string;
  goal: string;
  context_links: string[];
  scope: { touches: string[]; forbidden: string[] };
  constraints: {
    style?: string[];
    no_new_dependencies?: boolean;
    max_diff_lines: number;
    max_files?: number;
    notes?: string[];
  };
  acceptance: Array<{
    id: string;
    claim: string;
    probe_command: string;
    probe_id?: string;
    expected: string;
  }>;
  autonomy_tier: Tier;
  action_class?: ActionClass;
  environment?: Environment;
  budget: { caps: BudgetCaps; ttl_hours: number };
  escalate_if: Array<{ condition: string; to: 'program_lead' | 'chief_of_staff' | 'owner' | 'auditor' }>;
  output: { required_artifacts: ArtifactKind[]; result_schema?: string };
  roles: {
    doer: string;
    reviewers?: string[];
    verifier: string;
    approver: { kind: 'owner'; id: string };
  };
  delegation_packet_id?: string;
  provenance?: Provenance;
  issued_at?: string;
  expires_at?: string;
  supersedes?: string;
  content_hash?: string;
}

// ---------------------------------------------------------------------------
// vendor-adapter-input.json
// ---------------------------------------------------------------------------

export interface VendorAdapterInput {
  schema_version: '1';
  run_id: string;
  attempt: number;
  work_order: WorkOrder;
  workspace: { path: string; branch?: string; base_commit: string; read_only: boolean };
  /** Opaque handle; the broker injects secrets at the network edge. */
  credentials_handle: { handle_id: string; scopes: string[]; expires_at: string };
  budget: BudgetCaps;
  caps: { max_turns: number; max_wall_clock_s: number };
  result_schema_ref?: string;
  resume_session_id?: string;
  sandbox: {
    isolation: 'container' | 'microvm' | 'worktree_only';
    network_policy: 'deny_all' | 'allowlist';
    egress_allowlist?: string[];
    proxy?: string;
  };
  tool_allowlist: Array<{
    server: string;
    tool: string;
    definition_hash: string;
    returns_untrusted?: boolean;
    reads_sensitive?: boolean;
    changes_state?: boolean;
  }>;
  skills?: Array<{ skill_id: string; version: string; content_hash: string }>;
  context_provenance: Provenance;
  instruction_files?: Array<{ path: string; sha256: string }>;
  planner_text_is_data: true;
}

// ---------------------------------------------------------------------------
// run-result.json
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'budget_exceeded'
  | 'needs_input'
  | 'refused'
  | 'stopped';

export interface RunResultCost {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  usd: number;
}

export interface RunResult {
  schema_version: '1';
  run_id: string;
  work_order_id: string;
  adapter: { vendor: Vendor; name: string; version: string; model: string };
  session_id: string;
  status: RunStatus;
  exit_code: number;
  started_at?: string;
  ended_at?: string;
  cost: RunResultCost;
  turns?: number;
  tool_call_count?: number;
  artifacts: ArtifactPointer[];
  claims?: Array<{ acceptance_id: string; claim: string; evidence_ref?: string; tool_call_id?: string }>;
  diff_stats?: { files_changed: number; lines_added: number; lines_removed: number };
  stop_requests?: Array<{ condition: string; andon?: boolean; detail?: string }>;
  /** escalation-message.json; adapters never author one in C0, so it is typed loosely here. */
  escalation?: Record<string, unknown>;
  summary?: string;
  files_changed?: string[];
  tests_added?: string[];
  tests_modified?: string[];
  commands_run?: Array<{ command: string; tool_call_id: string }>;
  followups?: string[];
  injection_suspected?: InjectionSuspected;
}

// ---------------------------------------------------------------------------
// SDK: normalized step events (shape of a run_steps row in schema.core.sql)
// ---------------------------------------------------------------------------

/** run_steps.kind */
export type StepKind =
  | 'prompt'
  | 'model_turn'
  | 'tool_call'
  | 'tool_result'
  | 'checkpoint'
  | 'stop_request'
  | 'escalation'
  | 'human_input';

/**
 * One run_steps row, plus the redacted content the daemon stores as a blob and points to with
 * content_ref. Content is always data from the vendor, never instructions.
 */
export interface RunStep {
  id: string;
  run_id: string;
  seq: number;
  kind: StepKind;
  /** Null until the daemon stores the content and assigns a reference. */
  content_ref: string | null;
  /** sha256 of `content` (after redaction). */
  content_hash: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
  /** Redacted, size-capped content. Untrusted data. */
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  is_error?: boolean;
}

export type CapName = 'wall_clock' | 'turns' | 'tokens' | 'usd';

export type AdapterErrorCode =
  | 'malformed_line'
  | 'unexpected_shape'
  | 'line_too_long'
  | 'cli_not_found'
  | 'version_unreadable'
  | 'missing_flag'
  | 'preflight_failed'
  | 'credential_missing'
  | 'credential_rejected'
  | 'instruction_hash_mismatch'
  | 'unknown_scenario'
  | 'spawn_failed'
  | 'internal';

export type AdapterEvent =
  | { type: 'step'; step: RunStep }
  | {
      type: 'error';
      code: AdapterErrorCode;
      message: string;
      at: string;
      /** Redacted, short preview of the offending input, if any. */
      preview?: string;
      byte_length?: number;
    }
  | { type: 'session'; session_id: string; model?: string; at: string }
  | { type: 'cap_breach'; cap: CapName; limit: number; observed: number; at: string }
  | { type: 'killed'; reason: string; at: string }
  | {
      type: 'process';
      phase: 'spawned' | 'exited';
      pgid?: number;
      exit_code?: number;
      signal?: string;
      at: string;
    };

/** runs.failure_class in schema.core.sql */
export type FailureClass =
  | 'adapter'
  | 'schema'
  | 'no_artifact'
  | 'claim_mismatch'
  | 'nonzero_exit'
  | 'timeout'
  | 'budget'
  | 'killed'
  | 'cancelled'
  | 'policy';

export interface Fingerprint {
  name: string;
  version: string;
  help_sha256: string;
}

export interface PreflightReport {
  fingerprint: Fingerprint;
  /** Flags the preflight confirmed in the help text. Only these may appear in argv. */
  verified_flags: string[];
}

export interface CostRecord {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  usd: number;
  /** True when the vendor reported no dollar figure and the adapter estimated it from tokens. */
  estimated: boolean;
}

/** Facts about a run that run-result.json has no field for. The daemon records them on the run. */
export interface RunMeta {
  fingerprint: Fingerprint | null;
  cost: CostRecord;
  failure_class: FailureClass | null;
  cap_breach: { cap: CapName; limit: number; observed: number } | null;
  killed_reason: string | null;
  /** Process group id of the vendor process, if it was spawned. */
  pgid: number | null;
  error_count: number;
  /** Where each artifact came from: `git` was derived by the adapter, `claimed` came from the vendor. */
  artifact_sources: Array<'git' | 'claimed'>;
  /** Last lines of vendor stderr, redacted. */
  stderr_tail: string[];
}

export interface AdapterCapabilities {
  supports_resume: boolean;
  supports_schema: boolean;
  supports_budget_cap: boolean;
}

export interface StartOptions {
  /**
   * Credential environment variables injected by the daemon (for example the vendor API key).
   * Never logged, never placed in argv, and redacted by value from every event and result.
   */
  credentialEnv?: Record<string, string>;
  /** HOME for the vendor process. Defaults to a fresh temporary directory per run. */
  homeDir?: string;
  /** Grace period between SIGTERM and SIGKILL to the process group. Default 1500 ms. */
  killGraceMs?: number;
  /**
   * FW-C-043: lets this one run search and read the public web (a flow cycle with a hunt due). Off by
   * default, so ledger runs and other cycles stay offline.
   */
  web?: boolean;
  /** Fake adapter only: overrides the scenario tag in the work order title. */
  scenario?: string;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface AdapterRun {
  readonly run_id: string;
  /** Normalized events, redacted. Ends after `result` settles. Single consumer. */
  readonly events: AsyncIterable<AdapterEvent>;
  /** Always resolves (never rejects) with a redacted run-result. */
  readonly result: Promise<RunResult>;
  readonly meta: Promise<RunMeta>;
  /** Kill the whole process group (SIGTERM, then SIGKILL after the grace period). */
  kill(reason: string): Promise<void>;
  /** Process group id once spawned, else null. */
  pgid(): number | null;
}

export interface VendorAdapter {
  readonly name: string;
  readonly vendor: Vendor;
  readonly capabilities: AdapterCapabilities;
  start(input: VendorAdapterInput, opts?: StartOptions): AdapterRun;
  fingerprint(): Promise<Fingerprint>;
  /** Rejects with an AdapterError when the vendor CLI cannot be verified (fails closed). */
  preflight(): Promise<PreflightReport>;
}
