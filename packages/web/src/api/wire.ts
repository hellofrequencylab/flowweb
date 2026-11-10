/**
 * Wire shapes from fwd's local API v1 (docs/api/LOCAL-API-V1.md).
 * Field names are schema.core.sql column names. Fields marked PROPOSED are not
 * served yet (see the doc's "Still not served" list); the UI treats them as
 * optional and falls back honestly ("Unknown") when they are missing.
 */

export interface Envelope<T> {
  data: T;
  as_of: string;
  head_seq: number;
  next_cursor: string | null;
}

export interface WireError {
  error: { code: string; message: string; details?: unknown };
}

export interface WStatus {
  daemon: 'up';
  version: string;
  started_at: string;
  /** Agreed with Core (2026-11-09). Older drafts called this kill_switch. */
  kill: {
    engaged: boolean;
    engaged_at?: string | null;
    reason?: string | null;
    runs_to_halt?: number;
    runs_halted?: number;
    keys_revoked?: boolean;
  };
  chain: {
    ok: boolean;
    head_seq: number;
    head_hash: string;
    verified_at: string;
    failed_seq?: number | null;
  };
  /** null until a run has recorded a sandbox level (fresh install, no runs yet). */
  sandbox_level: 'enforced' | 'best_effort' | 'none' | null;
  open_cards: number;
  running_runs: number;
  spend?: {
    today_usd: number;
    daily_cap_usd: number;
    vendors_reporting: string[];
    vendors_configured?: string[];
    estimated?: boolean;
  };
  breaker?: { tripped: boolean; reason?: string | null };
  paused_by_budget?: boolean;
  /** Served from c0/08. */
  oldest_open_card_at?: string | null;
  /** FW-C-071: missing from an older fwd. */
  sender?: { installed: boolean; last_pass_at: string | null };
}

export interface WProject {
  id: string;
  slug: string;
  name: string;
  kind: string;
  repo_url: string | null;
  default_branch: string;
  status: 'active' | 'paused' | 'archived';
  wip_limit: number;
  /** From settings 'project_labels' (`fw project label`); absent from an older fwd. */
  brand?: string | null;
  category?: string | null;
  /** FW-C-087: the Owner's brief (five answers), or null; absent from an older fwd. */
  brief?: {
    what: string;
    who: string;
    voice: string;
    never: string;
    done: string;
    updated_at?: string;
  } | null;
  /** Served from c0/08: open+ready, claimed..merging, awaiting_approval+blocked. */
  rows_open?: number;
  rows_in_progress?: number;
  rows_waiting_on_owner?: number;
  last_run_at?: string | null;
}

export interface WLedgerRow {
  id: string; // lr_FWC019
  /** Derived, read-only human code, e.g. FW-C-019 (agreed). */
  code: string;
  project_id: string;
  stream_id: string | null;
  title: string;
  /** PROPOSED: one-paragraph description from the backlog */
  description?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  lane: string;
  size: string;
  status:
    | 'open'
    | 'ready'
    | 'claimed'
    | 'running'
    | 'verifying'
    | 'awaiting_approval'
    | 'merging'
    | 'watching'
    | 'done'
    | 'blocked'
    | 'parked'
    | 'regressed';
  /** PROPOSED */
  blocked_reason?: string | null;
  depends_on: string[];
  links: string[];
  wave: string | null;
  probe_kind: string;
  probe_spec: { argv?: string[]; cwd?: string; timeout_s?: number; [k: string]: unknown };
  probe_expected: Record<string, unknown>;
  probe_measures: string;
  probe_runs_against: string;
  probe_hash: string;
  premise_retested_at: string | null;
  premise_valid: 0 | 1 | null;
  merged_sha: string | null;
  last_probe_status: 'never' | 'pass' | 'fail' | 'error';
  last_probe_at: string | null;
  /** PROPOSED: which commit and what kind of target the last probe ran on */
  last_probe_sha?: string | null;
  last_probe_target?: 'branch' | 'merged' | 'deployed' | 'external' | null;
  last_probe_output_ref?: string | null;
  /** PROPOSED: acceptance items with last result */
  acceptance?: { text: string; last_result: 'never' | 'pass' | 'fail' | 'error'; at?: string | null }[];
  evidence_bundle_id: string | null;
  /** Served from c0/08 on /ledger/rows/{id}. */
  last_run_id?: string | null;
  watch_until: string | null;
  updated_at: string;
  closed_at: string | null;
}

export interface WLedgerRowDetail extends WLedgerRow {
  evidence: { id: string; created_at: string; scan_red: 0 | 1 }[];
  runs: WRun[];
  /** Served from c0/08: the 50 newest events whose payload names the row. */
  events?: WEvent[];
}

export interface WRun {
  id: string;
  work_order_id: string;
  project_id: string;
  /** The row this run works on (agreed: row_code). */
  ledger_row_id?: string;
  row_code?: string;
  /** PROPOSED: the agent's role */
  agent_role?: 'worker' | 'verifier' | 'chief_of_staff' | 'program_lead';
  agent_id: string;
  adapter_name: string;
  adapter_vendor: 'anthropic' | 'openai' | 'google' | 'local' | 'other';
  adapter_version: string | null;
  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'paused'
    | 'validating'
    | 'succeeded'
    | 'failed'
    | 'timed_out'
    | 'killed'
    | 'cancelled';
  exit_code: number | null;
  failure_class: string | null;
  cost_usd: number;
  /** PROPOSED: true when cost comes from a vendor estimate rather than a bill */
  cost_estimated?: boolean;
  tokens_in: number;
  tokens_out: number;
  turns: number;
  started_at: string | null;
  ended_at: string | null;
  sandbox_level: 'enforced' | 'best_effort' | 'none';
  /** Derived from leases.heartbeat_at (agreed). Running is shown only while under 120 s old. */
  last_heartbeat_at?: string | null;
  /** Served (c0/08): true when any run_artifacts row has verified_by_kernel = 1 */
  artifact_verified?: boolean;
  /** PROPOSED */
  model?: string;
  branch: string | null;
  result?: { summary?: string; claims?: { claim: string; evidence_ref?: string }[] } | null;
  /** Served from c0/08 on /runs/{id}. */
  artifacts?: {
    kind: string;
    ref: string;
    sha: string | null;
    claimed_by_agent: boolean;
    verified_by_kernel: boolean;
    verified_at: string | null;
  }[];
  /** PROPOSED: verifier run result for this run */
  verifier?: {
    verdict: 'concur' | 'concerns' | 'reject';
    vendor: string;
    summary: string;
    same_vendor_review: boolean;
  } | null;
}

export interface WRunStep {
  id: string;
  run_id: string;
  seq: number;
  kind:
    | 'prompt'
    | 'model_turn'
    | 'tool_call'
    | 'tool_result'
    | 'checkpoint'
    | 'stop_request'
    | 'escalation'
    | 'human_input';
  content_ref: string | null;
  /** PROPOSED: a one-line label the platform writes ("Edit packages/web/src/table/Card.tsx") */
  label?: string;
  /** PROPOSED: redacted excerpt for the selected-step pane */
  excerpt?: string;
  /** PROPOSED: set when policy denied the tool call */
  denied_by_policy?: string | null;
  /** PROPOSED: true when the content came from outside (tool output, comments) */
  untrusted?: boolean;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
}

export interface WEvidenceBundle {
  id: string;
  subject_kind: string;
  subject_ref: string;
  subject_sha: string | null;
  bundle_hash: string;
  scan_red: 0 | 1;
  captured_by: 'ci_sandbox' | 'kernel';
  created_at: string;
  /** Exactly evidence-bundle.json (its schema forbids extra fields). */
  body: {
    intent_payload: { rendered_ref: string; payload_hash: string; format: string };
    automated_evidence: {
      name: string;
      kind: string;
      status: 'pass' | 'fail' | 'warn' | 'skipped';
      artifact_ref?: string;
      ran_at: string;
      summary?: string;
    }[];
    visual_evidence?: { ref: string; viewport: string; label: string }[];
    blast_radius: {
      summary: string;
      affected?: string[];
      reversible: boolean;
      rollback_plan: string;
      rollback_tested: boolean;
    };
    independent_check?: {
      reviewer_agent_id: string;
      vendor: string;
      verdict: 'concur' | 'concerns' | 'reject';
      findings_ref?: string;
      same_vendor_review?: boolean;
    };
    cost_estimate_usd?: number;
    not_verified?: string[];
  };
  /** Derived by fwd from body (agreed). Any part the bundle does not prove is null. */
  view: {
    probe: { exit_code: number; output_tail: string; duration_ms: number } | null;
    diff: { hash: string; files: { path: string; added: number; removed: number; status?: string }[] } | null;
    policy: { rule: string; verdict: string; detail?: string }[] | null;
    sandbox: { level: 'enforced' | 'best_effort' | 'none'; controls?: string[] } | null;
    adapter: { name: string; version: string; help_sha256?: string } | null;
    /** PROPOSED */
    tests_removed_or_skipped?: string[] | null;
    /** PROPOSED */
    tokens?: { input: number; output: number; estimated: boolean } | null;
    /** PROPOSED: the verifier's one-line summary */
    verifier_summary?: string | null;
  };
}

/* GET /evidence-bundles/{id}/diff returns text/x-diff: the exact bytes behind the payload hash. Parsed in diff.ts. */

export interface WCard {
  id: string;
  variant: 'approve' | 'choose' | 'answer' | 'review' | 'unblock';
  project_id: string | null;
  title: string;
  ask: string;
  urgency: 'now' | 'today' | 'this_week' | 'whenever';
  deadline_at: string | null;
  default_on_timeout: string;
  approval_id: string | null;
  evidence_bundle_id: string | null;
  body: Record<string, unknown>; // decision-card.json
  status: 'open' | 'snoozed' | 'answered' | 'expired' | 'withdrawn';
  answer: Record<string, unknown> | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
  /** Joined in by the daemon (agreed). */
  row_code?: string | null;
  /** Served from c0/08. */
  project_name?: string;
  /** PROPOSED */
  asked_by?: 'verifier' | 'chief_of_staff' | 'worker' | 'system';
  snoozed_until?: string | null;
}

/** GET /decision-cards/{id} (agreed). merge_slot and policy are null until C1. */
export interface WCardDetail extends WCard {
  approval?: {
    payload_hash: string;
    head_sha: string | null;
    expires_at: string;
    status?: WApproval['status'];
  } | null;
  pr?: { url: string; number: number; current_head_sha: string; head_observed_at: string } | null;
  merge_slot?: { held: boolean; expires_at?: string | null } | null;
  policy?: { rule_id: string; rule_version: number; reason: string; tier: string } | null;
  files?: { path: string; added: number; removed: number }[];
  /** PROPOSED: estimated cost of the run that produced the change */
  cost_usd?: number | null;
  superseded_by_card_id?: string | null;
}

export interface WApproval {
  id: string;
  tier: string;
  subject_kind: string;
  subject_ref: string;
  payload_hash: string;
  head_sha: string | null;
  evidence_bundle_id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'superseded' | 'revoked' | 'consumed';
  expires_at: string;
  default_on_timeout: 'deny';
  decision: 'approved' | 'denied' | 'changes_requested' | null;
  responded_at: string | null;
  /** PROPOSED: the PR head fwd sees now; differs from head_sha when the agent pushed again */
  current_head_sha?: string | null;
  superseded_by_card_id?: string | null;
  /** PROPOSED */
  merge_slot?: { held: boolean; expires_at?: string } | null;
  /** PROPOSED: estimated cost of the run that produced this change */
  cost_usd?: number;
}

export interface WEvent {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor_kind: 'owner' | 'agent' | 'system' | 'adapter';
  actor_id: string;
  project_id: string | null;
  run_id: string | null;
  payload: Record<string, unknown>;
}

export interface WSpend {
  group_by: string;
  from: string;
  to: string;
  groups: { key: string; label?: string; usd: number; tokens_in: number; tokens_out: number }[];
  total_usd: number;
  /** PROPOSED */
  vendors_reporting?: number;
  vendors_total?: number;
}

export interface WBudget {
  id: string;
  scope_kind: string;
  scope_id: string;
  period: string;
  max_usd: number | null;
  breaker_daily_usd: number | null;
  breaker_velocity_usd_per_h: number | null;
  spent_usd: number;
}

/** GET /status-reports?kind=daily&limit=1 (agreed; empty until the C2 digest ships). */
export interface WStatusReport {
  id: string;
  kind: 'daily';
  period_from: string;
  period_to: string;
  data_as_of: string;
  created_at: string;
  body: {
    self_check?: { passed: boolean; failed_query_ids: string[] };
    headline: string;
    done: { ledger_row_id?: string; text: string; link?: string }[];
    blocked: { ledger_row_id?: string; text: string; needs: string }[];
  };
}

/** GET /status-reports?kind=run: one flow cycle, written by fwd when the cycle ends (FW-C-038). */
export interface WFlowCycleReport {
  id: string;
  kind: 'run';
  period_from: string;
  period_to: string;
  created_at: string;
  body: {
    flow?: string;
    adapter?: string;
    outcome?: 'drafted' | 'dry' | 'failed';
    drafts?: number;
    hunts?: { id: string; found?: number }[];
    reason?: string;
  };
}

/** GET /session (agreed, C2 with pairing). 401 when not paired. */
export interface WSession {
  paired_at: string;
  device_label?: string | null;
}

/** Hosted mirror only: GET /hosted/machines (not part of fwd's API). */
export interface WMachine {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  report: {
    relay_version?: string;
    label?: string;
    fwd_version?: string | null;
    head_seq?: number | null;
    entries?: number;
    /** Yes or no per sign-in, from the relay. null: the machine could not tell. Never a secret. */
    accounts?: {
      checked_at: string;
      claude_api_key: boolean | null;
      claude_signin_token: boolean | null;
      codex_api_key: boolean | null;
      codex_signin: boolean | null;
    };
    /** The last `fw accounts check` on the machine: a tiny real call per account. null: never run. */
    account_test?: WAccountTest | null;
  };
}

export interface WAccountTest {
  checked_at: string | null;
  accounts: Partial<
    Record<
      'claude_signin' | 'claude_api_key' | 'codex_signin' | 'codex_api_key',
      { set_up: boolean | null; ok: boolean | null; detail: string | null; fix: string | null }
    >
  >;
  start_command: string | null;
}

/** GET /policy (agreed) */
export interface WPolicy {
  path: string;
  commit: string;
  sha256: string;
  text: string;
}
