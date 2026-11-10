/**
 * View models the web UI reads from fwd's local API (/api/v1).
 *
 * These are the shapes the screens need. Where a field mirrors a contract in
 * packages/contracts/json-schema (decision-card, evidence-bundle, ledger-row,
 * run-result, approval-response, event-envelope), it keeps that contract's
 * name and enum values. When FW-C-018 generates the typed client from
 * openapi.json, this file is replaced by the generated types and any
 * difference is a bug in one or the other. See API.md.
 *
 * Rule: every response carries `data_as_of` (when fwd read it from the
 * database). The UI never shows a value without knowing its age.
 */

export type Iso = string; // RFC 3339 timestamp
export type Sha256 = string;
export type GitSha = string;
export type Vendor = 'anthropic' | 'openai' | 'google' | 'local' | 'other';

export interface Envelope {
  data_as_of: Iso;
}

/* ---------- session ---------- */

export interface Session {
  paired_at: Iso;
  device_label?: string | null;
}

/** Hosted mirror only: machines pushing to the live site. */
export interface MachineList extends Envelope {
  machines: import('./wire').WMachine[];
}

/* ---------- status (the strip, banners, global state) ---------- */

export type KillState = 'ready' | 'stopping' | 'stopped';
export type SandboxEgress = 'enforced' | 'best_effort' | 'none';

export interface Status extends Envelope {
  kill_switch: {
    state: KillState;
    engaged_at?: Iso;
    engaged_by?: 'owner' | 'system';
    runs_halted?: number;
    runs_to_halt?: number;
    keys_revoked?: boolean;
  };
  cards_open: number;
  running_runs: number;
  oldest_card_created_at?: Iso;
  /** Missing when fwd does not report it yet: shown as Unknown, never as $0. */
  spend_today?: SpendToday;
  breaker?: { tripped: boolean; reason?: string };
  paused_by_budget?: boolean;
  /** null means not measured yet (no run has recorded a level): neutral, not a problem. */
  sandbox_egress: SandboxEgress | null;
  integrity: Integrity;
  /** Last event sequence number fwd has written. */
  last_seq: number;
  version: string;
  /** FW-C-071: undefined from an older fwd; treated as no sender. */
  sender?: SenderStatus;
}

/**
 * FW-C-071: whether a sender on the Owner's Mac reads the outbox. installed means it ran in the last 24
 * hours; last_pass_at is when it last ran, or null if it never has.
 */
export interface SenderStatus {
  installed: boolean;
  last_pass_at: Iso | null;
}

export interface SpendToday {
  usd: number;
  cap_usd: number;
  vendors_reporting: string[];
  /** Unknown when fwd does not say how many vendors are configured. */
  vendors_configured?: string[];
  forecast_usd?: number;
  estimated: boolean;
}

export interface Integrity {
  ok: boolean;
  verified_up_to_seq: number;
  checked_at: Iso;
  failed_at_seq?: number | null;
}

/* ---------- Console ---------- */

export interface DawnLog extends Envelope {
  /** null when no digest exists yet, or it failed its own check: the screen shows live counts, labelled. */
  digest: {
    id: string;
    produced_at: Iso;
    since: Iso;
    self_check_ok: boolean;
    failed_query_ids: string[];
    headline: string;
  } | null;
  since: Iso;
  rows_done: LandedRow[];
  rows_watching: LandedRow[];
  runs: { succeeded: number; failed: number; halted: number; total: number };
}

export interface LandedRow {
  row_id: string; // human id, e.g. "FW-C-019"
  ledger_row_id: string; // lr_...
  title: string;
  merged_sha: GitSha;
  probe_result_id?: string;
  probe_status: ProbeStatus;
  probe_at?: Iso;
}

/* ---------- Sign-offs ---------- */

export type CardVariant = 'approve' | 'choose' | 'answer' | 'review' | 'unblock';
export type Urgency = 'now' | 'today' | 'this_week' | 'whenever';
export type AutonomyTier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

/** Lifecycle of a card as fwd sees it. */
export type CardState =
  | 'open'
  | 'approving' // response posted, waiting for fwd to confirm
  | 'approved'
  | 'denied'
  | 'answered'
  | 'snoozed'
  | 'expired'
  | 'withdrawn'
  | 'stale'; // head moved after the card was raised

export interface CardSummary {
  id: string;
  variant: CardVariant;
  title: string;
  project_name?: string;
  row_id?: string;
  created_at: Iso;
  deadline_at?: Iso;
  urgency: Urgency;
  state: CardState;
}

export interface CardList extends Envelope {
  cards: CardSummary[];
}

interface CardBase {
  id: string;
  variant: CardVariant;
  state: CardState;
  title: string;
  ask: string;
  urgency: Urgency;
  /** From the routing policy; null until fwd reports it (C1). */
  autonomy_tier: string | null;
  project_id: string | null;
  project_name?: string;
  row_id?: string;
  asked_by?: 'verifier' | 'chief_of_staff' | 'worker' | 'system';
  created_at: Iso;
  deadline_at?: Iso;
  default_on_timeout: string;
  evidence_bundle_id?: string;
  /** Which policy rule sent this to the Owner; null until fwd reports it (C1). */
  why: { rule_id: string; text: string } | null;
  resolution?: {
    at: Iso;
    by: 'owner' | 'system';
    decision: string;
    reason?: string;
  };
  snoozed_until?: Iso;
}

export interface ApproveCard extends CardBase {
  variant: 'approve';
  approval_id: string;
  headline: string;
  payload_preview: {
    format: 'diff' | 'text' | 'email' | 'sql' | 'invite';
    excerpt?: string;
    full_ref: string;
    payload_hash: Sha256;
  };
  head_sha: GitSha | null;
  expires_at?: Iso;
  /** The PR head fwd sees now. Differs from head_sha when the agent pushed again. */
  current_head_sha?: GitSha;
  head_observed_at?: Iso;
  pr?: { url: string; number: number };
  replacement_card_id?: string;
  risk: {
    blast_radius: string;
    reversible: boolean;
    rollback_tested?: boolean;
    scan_status: 'green' | 'warn';
  };
  cost_usd?: number | null;
  files?: DiffFileStat[];
  merge_slot?: { held: boolean; expires_at?: Iso | null } | null;
}

export interface ChooseCard extends CardBase {
  variant: 'choose';
  options: {
    id: string;
    label: string;
    consequence: string;
    cost_usd?: number;
    reversible?: boolean;
  }[];
  recommended_option: string;
  recommendation_reason: string;
}

export interface AnswerCard extends CardBase {
  variant: 'answer';
  question: string;
  answer_type: 'text' | 'number' | 'date' | 'yes_no' | 'choice';
  constraints?: { min?: number; max?: number; max_length?: number; choices?: string[] };
  suggested_answer?: string;
  basis_gap?: string;
}

export interface ReviewCard extends CardBase {
  variant: 'review';
  artifact: { kind: string; ref: string; title?: string };
  verifier_summary?: string;
}

export interface UnblockCard extends CardBase {
  variant: 'unblock';
  blocker: { kind: string; description: string; since: Iso };
  suggested_actions: { id: string; label: string; consequence?: string }[];
}

export type DecisionCard = ApproveCard | ChooseCard | AnswerCard | ReviewCard | UnblockCard;

export interface CardDetail extends Envelope {
  card: DecisionCard;
}

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped' | 'pending';
export interface CheckSummary {
  name: string;
  kind: string;
  status: CheckStatus;
}

export type ReasonCode = 'wrong_approach' | 'not_now' | 'too_risky' | 'needs_test' | 'other';

/** POST /api/v1/cards/:id/respond. Mirrors approval-response.json for approve cards. */
export type CardResponse =
  | { decision: 'approved'; payload_hash: Sha256; head_sha: GitSha }
  | { decision: 'denied'; payload_hash?: Sha256; reason_code: ReasonCode; comment?: string }
  | { decision: 'changes_requested'; comment: string }
  | { decision: 'chosen'; option_id: string }
  | { decision: 'answered'; answer: string | null; used_default?: boolean; dont_know?: boolean }
  | { decision: 'action'; action_id: string }
  | { decision: 'snoozed'; until: Iso };

/* ---------- Evidence ---------- */

export interface Evidence extends Envelope {
  bundle_id: string;
  bundle_hash: Sha256;
  payload_hash: Sha256;
  diff_hash?: Sha256;
  subject: { kind: string; ref: string; sha?: GitSha | null };
  captured_by: 'ci_sandbox' | 'kernel';
  scan_red: boolean;
  checks: {
    name: string;
    kind: string;
    status: Exclude<CheckStatus, 'pending'>;
    ran_at: Iso;
    summary?: string;
    artifact_ref?: string;
  }[];
  independent_check?: {
    vendor: string;
    verdict: 'concur' | 'concerns' | 'reject';
    summary?: string;
    findings_ref?: string;
    same_vendor_review: boolean;
  };
  blast_radius: {
    summary: string;
    affected: string[];
    reversible: boolean;
    rollback_plan: string;
    rollback_tested: boolean;
  };
  files: DiffFileStat[];
  tests_removed_or_skipped: string[];
  probe: { exit_code: number; tail: string; duration_ms: number; output_ref?: string } | null;
  cost: { usd?: number; input_tokens?: number; output_tokens?: number; estimated: boolean };
  sandbox?: { level: SandboxEgress; controls: string[] };
  adapter?: { name: string; version: string };
  screenshots: { ref: string; viewport: string; label: string }[];
  not_verified: string[];
}

export interface ParsedDiff extends Envelope {
  /** sha256 of the raw bytes, computed in the browser. */
  sha256: Sha256;
  files: DiffFile[];
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** n is the line's position in the raw diff, a stable key. */
  hunks: { header: string; n: number; lines: { n: number; op: '+' | '-' | ' '; text: string }[] }[];
}

/* ---------- Projects, ledger ---------- */

export interface Project {
  id: string;
  name: string;
  repo: string | null;
  status: 'active' | 'paused' | 'archived';
  /** Business or brand the project belongs to, e.g. "Frequency"; null when unlabelled. */
  brand: string | null;
  /** marketing | product | ops | sales | support | finance | other; null when unlabelled. */
  category: string | null;
  rows_open?: number;
  rows_in_progress?: number;
  rows_waiting_on_owner?: number;
  last_run_at?: Iso | null;
}

export interface ProjectList extends Envelope {
  projects: Project[];
}

/** Mirrors ledger-row.json status enum, plus the UI split of watching vs done. */
export type RowStatus =
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

export type ProbeStatus = 'never' | 'pass' | 'fail' | 'error';

export interface RowSummary {
  ledger_row_id: string;
  row_id: string;
  title: string;
  status: RowStatus;
  blocked_reason?: string | null;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  lane: string;
  depends_on: string[];
  last_probe: {
    status: ProbeStatus;
    at?: Iso | null;
    target_kind?: 'branch' | 'merged' | 'deployed' | 'external' | null;
  };
  last_run_id?: string | null;
  evidence_bundle_id?: string | null;
  updated_at: Iso;
}

export interface RowList extends Envelope {
  rows: RowSummary[];
}

export interface RowDetail extends Envelope {
  row: RowSummary & {
    description?: string;
    size: string;
    probe: {
      kind: string;
      measures: string;
      command: string;
      runs_against: string;
      content_hash: Sha256;
    };
    last_probe_detail?: {
      status: ProbeStatus;
      sha?: GitSha | null;
      at?: Iso | null;
      output_ref?: string | null;
    };
    premise?: { retested_at: Iso; still_valid: boolean | null };
    acceptance?: { text: string; last_result: ProbeStatus; at?: Iso | null }[];
    merged_sha?: GitSha | null;
  };
  evidence: { id: string; created_at: Iso; scan_red: boolean }[];
  runs: RunSummary[];
}

/* ---------- Runs ---------- */

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'paused'
  | 'checking'
  | 'finished_unchecked'
  | 'artifact_verified'
  | 'claimed_unverified'
  | 'failed'
  | 'timed_out'
  | 'halted'
  | 'cancelled';

export interface RunSummary {
  run_id: string;
  row_id?: string;
  role?: 'worker' | 'verifier' | 'chief_of_staff' | 'program_lead';
  vendor: Vendor;
  adapter: string;
  status: RunStatus;
  started_at?: Iso;
  ended_at?: Iso;
  /** Last heartbeat from the agent process. "running" is only shown while this is fresh. */
  heartbeat_at?: Iso | null;
  cost_usd: number;
  cost_estimated: boolean;
  sandbox: SandboxEgress;
}

export interface RunList extends Envelope {
  runs: RunSummary[];
}

/**
 * FW-C-075: work a flow did, which fwd records as a status report rather than a run: one flow cycle
 * (kind run) or one daily digest (kind daily).
 */
export interface FlowRun {
  id: string;
  kind: 'cycle' | 'digest';
  /** The flow's key, for example neighborhood-activation; "digest" for the digest. */
  flow: string;
  outcome: 'drafted' | 'dry' | 'failed' | 'published' | 'unknown';
  drafts: number;
  /** Leads found by the hunts that ran inside this cycle. */
  found: number;
  engine?: string;
  reason?: string;
  started_at: Iso;
  ended_at: Iso;
}

export interface FlowRunList extends Envelope {
  flow_runs: FlowRun[];
}

export interface RunDetail extends Envelope {
  run: RunSummary & {
    exit_code?: number | null;
    failure_class?: string | null;
    input_tokens: number;
    output_tokens: number;
    turns: number;
    tool_version?: string | null;
    model?: string;
    branch?: string | null;
    summary?: string;
  };
  artifacts_verified: { kind: string; ref: string; sha?: string | null; verified_at?: string | null }[];
  artifacts_claimed: { id: string; kind?: string; claim: string; ref?: string }[];
  verifier?: {
    verdict: 'concur' | 'concerns' | 'reject';
    vendor: string;
    summary: string;
    same_vendor_review: boolean;
  } | null;
}

export interface RunSteps extends Envelope {
  steps: {
    id: string;
    seq: number;
    kind: string;
    label: string;
    at: Iso;
    ended_at?: Iso | null;
    excerpt?: string;
    blocked_by_policy?: string | null;
    external_text: boolean;
    cost_usd: number;
  }[];
}

export interface EventList extends Envelope {
  events: EventItem[];
}

/* ---------- Spend ---------- */

export interface Spend extends Envelope {
  today?: SpendToday;
  by_day: { day: string; usd: number }[];
  by_project: { key: string; label: string; usd: number }[];
  by_vendor: { key: string; label: string; usd: number }[];
  refused: { seq: number; at: Iso; type: string; summary: string }[];
  breaker?: {
    tripped: boolean;
    reason?: string | null;
    daily_usd: number | null;
    velocity_usd_per_hour: number | null;
  };
}

/* ---------- Flows ---------- */

export interface FlowSaturation {
  score: number;
  coverage: number;
  cadence: number;
  response: number;
}

export interface FlowArea {
  id: string;
  name: string;
  km_from_seed: number;
  population: number;
  saturation: FlowSaturation;
  signals: { targets_known: number; targets_reached: number; touches_28d: number; new_members_28d: number };
  awaiting_owner: number;
}

export type FlowDecision =
  | { kind: 'paused_budget'; summary: string }
  | { kind: 'propose_expansion'; ring: number; area_ids: string[]; summary: string }
  | { kind: 'keep_working'; summary: string }
  | { kind: 'all_saturated'; summary: string };

export interface Flow extends Envelope {
  key: string;
  name: string;
  enabled: boolean;
  tier: string;
  gate_on: string[];
  offer: { name: string; url: string; pitch: string; call_to_action: string; placeholder?: boolean };
  engine: { label: string; fallback: string; runs_on: string };
  channels: { key: string; label: string; action_class: string; placeholder?: boolean }[];
  placeholders: ('offer' | 'starting_area' | 'channels')[];
  thresholds: {
    threshold: number;
    hold_cycles: number;
    max_active_areas: number;
    ring_width_km: number;
    touches_per_target_28d: number;
    new_members_per_10k_28d: number;
  };
  open_ring: number;
  cycles_at_threshold: number;
  rings: { ring: number; open: boolean; average: number; areas: FlowArea[] }[];
  decision: FlowDecision;
  plan: { area_id: string; reason: string }[];
  steps: { key: string; label: string; outward: boolean }[];
  budget: {
    period: string;
    max_usd: number | null;
    max_turns: number | null;
    spent_usd: number;
    used_turns: number;
    since: string;
  };
  awaiting_owner_total: number;
}

export type ActivationMeasures = {
  hosts_active_28d: number;
  events_next_14d: number;
  sub_areas_covered_14d: number;
  wam: number;
};

export type LeadKind = 'host' | 'venue' | 'builder' | 'resident';
export type LeadStage = 'invite' | 'watch' | 'post_only' | 'capped' | 'blocked' | 'drop';
export type SendVia = 'founder_email' | 'frequency';

export interface ActivationTerritory {
  id: string;
  name: string;
  order: number;
  status: 'active' | 'upkeep' | 'waiting';
  borders: string[];
  population: number;
  sub_areas: { id: string; name: string; population: number }[];
  targets: ActivationMeasures;
  /** null when fwd has no metrics for the region: Unknown, never zero. */
  measures: ActivationMeasures | null;
  progress: number | null;
  qualifies: boolean | null;
  weeks_at_threshold: number;
  weeks_below: number;
  leads: Record<LeadKind, number>;
}

export interface ActivationLead {
  id: string;
  name: string;
  kind: LeadKind;
  territory_id: string;
  sub_area: string | null;
  channel: string | null;
  source: string;
  url: string;
  fit: number;
  timing: number;
  stage: LeadStage;
  reason: string;
  send_via: SendVia | null;
  funnel: { path: string; persona: string; url: string } | null;
}

export type ActivationDecision =
  | { kind: 'paused_budget'; summary: string }
  | { kind: 'keep_working'; summary: string }
  | { kind: 'propose_expansion'; territory_id: string; summary: string }
  | { kind: 'all_active'; summary: string };

export interface ActivationFlow extends Envelope {
  key: string;
  name: string;
  enabled: boolean;
  tier: string;
  gate_on: string[];
  offer: { name: string; url: string; pitch?: string; call_to_action?: string; placeholder?: boolean };
  engine: { label: string; fallback: string; runs_on: string };
  sources: { key: string; label: string; finds: string; reach: string; action_class: string }[];
  funnels: Record<LeadKind, { path: string; persona: string; placeholder?: boolean }>;
  send_routes: Record<SendVia, { label: string; one_to_one?: boolean; needs?: string[]; adds?: string[] }>;
  placeholders: string[];
  thresholds: { hold_weeks: number; upkeep_relapse_weeks: number; [k: string]: number };
  opened: string[];
  territories: ActivationTerritory[];
  leads: ActivationLead[];
  pipeline: Record<LeadStage, number>;
  decision: ActivationDecision;
  plan: { sub_areas: { territory_id: string; sub_area: string; reason: string }[]; invites: string[] };
  steps: { key: string; label: string; outward: boolean }[];
  budget: Flow['budget'];
  awaiting_owner_total: number;
}

/** A cycle's draft waiting in $FW_HOME/flows/<key>/drafts/ (GET /v1/supervisor/flows/{key}/drafts). */
export interface FlowDraft {
  id: string;
  fire_id: string | null;
  lead_id: string | null;
  channel: string | null;
  subject: string | null;
  body: string;
  status: string;
  held?: string;
  created_at: string | null;
  approved_at?: string;
  rejected_at?: string;
  edited_at?: string;
  /** FW-C-054: what the Owner says happened after they sent it by hand. */
  tag?: string;
  sent_at?: string;
  replied_at?: string;
  declined_at?: string;
}

export interface FlowDrafts extends Envelope {
  drafts: FlowDraft[];
}

/** FW-C-072: one value of a review dimension (a source, hunt, funnel, sub-area or message angle). */
export interface ReviewValue {
  value: string;
  name: string;
  sent: number;
  replied: number;
  signups: number;
  reply_rate: number | null;
  signup_rate: number | null;
}

export interface ReviewDimension {
  key: 'source' | 'hunt' | 'funnel' | 'sub_area' | 'angle';
  label: string;
  /** False when no sent draft carries this dimension yet. */
  tracked: boolean;
  /** How many values have at least min_sent sent. */
  judged: number;
  best: ReviewValue | null;
  worst: ReviewValue | null;
}

/** FW-C-072: what's working, from the flow's latest weekly review. */
export interface ReviewSummary extends Envelope {
  flow: string;
  state: 'none' | 'thin' | 'ready';
  at: string | null;
  week: string | null;
  min_sent: number;
  sample_ok: boolean;
  totals: Omit<ReviewValue, 'value' | 'name'>;
  dimensions: ReviewDimension[];
  learnings: string[];
}

/* ---------- Settings / policy ---------- */

export interface PolicyFile extends Envelope {
  path: string;
  commit: GitSha;
  sha256: Sha256;
  text: string;
}

/* ---------- Events ---------- */

export interface EventItem {
  seq: number;
  ts: Iso;
  type: string;
  actor: string;
  summary: string;
}

/** Resources a live event can invalidate. Derived from the event type in live.tsx. */
export type Topic = 'status' | 'cards' | 'dawn' | 'rows' | 'runs' | 'spend';

/** GET /v1/supervisor (FW-C-033): every shipped flow, ready or held by exactly one named gate. */
export type SupervisorGate =
  | 'kill_switch'
  | 'supervisor_paused'
  | 'flow_disabled'
  | 'no_engine'
  | 'dial_unapproved'
  | 'cap_required'
  | 'budget'
  | 'open_asks'
  | 'dormant'
  | 'stalled'
  | 'wip'
  | 'not_due'
  | 'machine_busy';

/** FW-C-035: Draft only drafts; Copilot acts after your OK; Autopilot hands off to a sender outside Core. */
export type SupervisorDial = 'draft' | 'copilot' | 'autopilot';

/** FW-C-063: a flow's morning run. time and days are null when the cron is not a simple daily one. */
export interface FlowSchedule {
  time: string | null;
  days: 'daily' | 'weekdays' | null;
  cron: string;
  timezone: string;
}

/** FW-C-063: how many new people a flow reaches a day. */
export interface FlowIntensitySetting {
  per_day: number;
  auto: boolean;
  min: number;
  max: number;
}
export interface FlowIntensity extends FlowIntensitySetting {
  today: { per_day: number; why: string };
}

export interface SupervisorFlow {
  key: string;
  name: string;
  enabled: boolean;
  dial: SupervisorDial;
  tier: string;
  state: 'ready' | 'held' | 'running';
  gate: SupervisorGate | null;
  reason: string;
  open_asks: number;
  budget: {
    max_usd: number | null;
    max_turns: number | null;
    period: string;
    spent_usd: number | null;
    used_turns: number | null;
  } | null;
  /** FW-C-063: when the flow's stream fires. Missing from a fwd older than FW-C-063. */
  schedule?: FlowSchedule | null;
  /** FW-C-063: new people a day, and today's number after Adjust from replies. */
  intensity?: FlowIntensity;
  /** FW-C-086: the AI account the flow's runs use; chosen when picked in Settings. Missing from an older fwd. */
  ai?: { adapter: 'claude' | 'codex'; auth?: 'signin' | 'api_key'; chosen: boolean } | null;
}

/** FW-C-086: the four AI accounts a flow can use. */
export type FlowAiAccount = 'claude_plan' | 'anthropic_key' | 'chatgpt_plan' | 'openai_key';

export interface Supervisor extends Envelope {
  kill_switch: boolean;
  paused: boolean;
  max_concurrent: number;
  running: number;
  gates: SupervisorGate[];
  flows: SupervisorFlow[];
  next: string[];
  /** FW-C-071: undefined from an older fwd; treated as no sender. */
  sender?: SenderStatus;
}

/** FW-C-039: GET /v1/setup. Every step is read from real state; a step not done names its fix. */
export type SetupStepId = 'machine' | 'sign_ins' | 'project' | 'brief' | 'flow' | 'live_site';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  required: boolean;
  done: boolean;
  detail: string;
  fix: string | null;
}

export interface Setup extends Envelope {
  ready: boolean;
  next: SetupStepId | null;
  fwd: 'up' | 'down';
  steps: SetupStep[];
  checked_at: string;
}

/* ---------------- paid ads flow (FW-C-048) ---------------- */

export interface AdsFigures {
  days: number;
  spend_usd: number;
  impressions: number;
  clicks: number;
  subscriptions: number;
  ctr: number | null;
  cost_per_click_usd: number | null;
  cost_per_subscription_usd: number | null;
}

export type AdsNextMove =
  | { kind: 'waiting_for_data'; why: string }
  | { kind: 'learning'; why: string; days_left: number }
  | { kind: 'check_tracking'; why: string }
  | { kind: 'over_target'; why: string }
  | { kind: 'on_target'; why: string };

export interface AdsFlow extends Envelope {
  key: string;
  name: string;
  enabled: boolean;
  campaign: { name: string; platform: string; goal: string; landing_url?: string };
  source: { kind: string; how: string };
  target_cost_per_subscription_usd: number;
  target_is_placeholder: boolean;
  learning_days: number;
  first_day: string | null;
  last_day: string | null;
  totals: AdsFigures;
  last_7_days: AdsFigures;
  next_move: AdsNextMove;
  /** FW-C-058: the automatic Google Analytics pull, null when the config names none. */
  pull: {
    property_id: string;
    every_hours: number;
    last: { ok: boolean; at: string; days?: number; error?: string } | null;
  } | null;
}
