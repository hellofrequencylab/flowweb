-- ============================================================================
-- FlowWeb CORE schema  (system of record for the Core profile)
-- Dialect: SQLite 3.38+ (WAL). Subset of 03-contracts/schema.sql.
--
-- Migration rule (Core -> full): every table here exists in the full schema with the SAME
-- name, column names, column semantics, id prefixes and CHECK vocabularies. Core omits whole
-- tables and some OPTIONAL columns; it never renames, retypes or re-purposes anything.
-- Moving to the full schema = CREATE the missing tables, ALTER TABLE ... ADD COLUMN the
-- omitted optional columns, INSERT the omitted reference rows, and swap a few Core triggers
-- for their stricter full-plan twins. See core/CORE-SPEC.md section 9 (evolution map).
--
-- What Core omits (and why) is in the table at the end of this file ("OMITTED").
--
-- Versions. This file is always the CURRENT schema: a new database is created from it.
-- A database created from an earlier version is brought forward by the forward-only upgrades
-- in packages/contracts/sql/migrations/ (applied by @fw/eventlog openStore, one transaction each).
--   1.0.0-core  first release.
--   1.1.0-core  runs.failure_class gains 'policy' (a diff-policy violation; the full schema
--               needs the same value); the secret tripwire also catches a bare PKCS#8 header
--               ("BEGIN PRIVATE KEY"). Upgrade: migrations/0002-core-1.1.0.sql.
--
-- Conventions (identical to the full schema): ids are prefixed text (prj_, stm_, wo_, lr_,
-- run_, agt_ ...); every JSON column is json_valid()-checked; every *_hash is lowercase hex
-- SHA-256; timestamps are UTC ISO-8601 text. The daemon opens every connection with
-- PRAGMA foreign_keys=ON (a per-connection setting in SQLite) and is the ONLY writer.
-- Agents never hold a DB handle.
--
-- 19 domain tables:
--   the 16 named in the Core brief:
--     projects, agents, streams, ledger_rows, work_orders, leases, runs, run_steps, events,
--     approvals, grants, decision_cards, budgets, spend_entries, policy_rules, settings
--   plus 3 that make "honest UI" and "done means proven" enforceable in the database:
--     run_artifacts, evidence_bundles, status_reports
-- 5 reference tables (seeded, tiny): autonomy_tiers, environments, action_classes,
--     legal_transitions, event_types;   1 meta table: schema_meta;   1 view: budget_usage.
-- ============================================================================
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
INSERT INTO schema_meta(key,value) VALUES
  ('schema_version','1.1.0-core'),
  ('profile','core'),
  ('full_schema_base','03-contracts/schema.sql 1.0.0'),
  ('json_schema_dialect','2020-12');

-- ----------------------------------------------------------------------------
-- Reference data (identical rows to the full schema, subset where noted)
-- ----------------------------------------------------------------------------
CREATE TABLE autonomy_tiers (
  tier TEXT PRIMARY KEY CHECK (tier IN ('L0','L1','L2','L3','L4','L5')),
  rank INTEGER NOT NULL UNIQUE CHECK (rank BETWEEN 0 AND 5),
  name TEXT NOT NULL,
  agent_may TEXT NOT NULL,
  human_role TEXT NOT NULL,
  requires_gate INTEGER NOT NULL CHECK (requires_gate IN (0,1))
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY CHECK (id IN ('sandbox','staging','production')),
  description TEXT NOT NULL
);

CREATE TABLE action_classes (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  irreversible INTEGER NOT NULL CHECK (irreversible IN (0,1))
);

CREATE TABLE legal_transitions (
  machine TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  guard TEXT NOT NULL,
  PRIMARY KEY (machine, from_state, to_state)
);

CREATE TABLE event_types (
  type TEXT PRIMARY KEY,
  producer TEXT NOT NULL,
  payload_summary TEXT NOT NULL,
  consumers TEXT NOT NULL,
  idempotency_key_rule TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- Principals and scope
-- (full schema has an `owners` table; Core has exactly one Owner, held in settings('owner'),
--  and every column that would reference owners(id) carries CHECK (... LIKE 'own_%') plus a
--  trigger that the id equals the configured Owner. Agents are never 'own_%'.)
-- ----------------------------------------------------------------------------
CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (id LIKE 'prj_%'),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo','inbox','calendar','helpdesk','docs','ops','other')),
  repo_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  wip_limit INTEGER NOT NULL DEFAULT 3 CHECK (wip_limit BETWEEN 1 AND 20),
  program_lead_agent_id TEXT,                    -- Core: the Chief of Staff agent plays program lead
  risk_appetite TEXT NOT NULL DEFAULT 'conservative' CHECK (risk_appetite IN ('conservative','balanced','aggressive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY CHECK (id LIKE 'agt_%'),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('chief_of_staff','program_lead','worker','verifier','auditor','watchdog')),
  vendor TEXT NOT NULL CHECK (vendor IN ('anthropic','openai','google','local','other')),
  model TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  supervisor_agent_id TEXT REFERENCES agents(id),
  tier TEXT NOT NULL DEFAULT 'L1' REFERENCES autonomy_tiers(tier),
  identity_pubkey TEXT,
  credential_handle TEXT,                        -- a handle, never a secret
  tool_manifest_hash TEXT CHECK (tool_manifest_hash IS NULL OR length(tool_manifest_hash) = 64),
  rule_of_two_flags TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rule_of_two_flags)),
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','active','suspended','quarantined','retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at TEXT,
  -- maker-checker structural rule: verifiers and auditors are never project-scoped writers
  CHECK (role NOT IN ('verifier','auditor','watchdog') OR tier IN ('L0','L1','L2'))
);
CREATE INDEX idx_agents_project_role ON agents(project_id, role, status);

-- ----------------------------------------------------------------------------
-- Budgets and spend
-- ----------------------------------------------------------------------------
CREATE TABLE budgets (
  id TEXT PRIMARY KEY CHECK (id LIKE 'bud_%'),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('fleet','project','stream','agent','work_order','run')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('run','day','week','month','ttl')),
  max_usd REAL CHECK (max_usd IS NULL OR max_usd >= 0),
  max_tokens INTEGER CHECK (max_tokens IS NULL OR max_tokens >= 0),
  max_minutes INTEGER CHECK (max_minutes IS NULL OR max_minutes >= 0),
  max_turns INTEGER CHECK (max_turns IS NULL OR max_turns >= 0),
  soft_threshold_pct INTEGER NOT NULL DEFAULT 80 CHECK (soft_threshold_pct BETWEEN 1 AND 100),
  hard_stop INTEGER NOT NULL DEFAULT 1 CHECK (hard_stop = 1),   -- a budget without a hard stop is not a budget
  breaker_daily_usd REAL,
  breaker_velocity_usd_per_h REAL,
  body TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body)),
  version INTEGER NOT NULL DEFAULT 1,
  set_by TEXT NOT NULL CHECK (set_by LIKE 'own_%'),             -- Tier 0: the Owner only
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope_kind, scope_id, period),
  CHECK (max_usd IS NOT NULL OR max_tokens IS NOT NULL OR max_minutes IS NOT NULL OR max_turns IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- Streams, ledger, work orders
-- ----------------------------------------------------------------------------
CREATE TABLE streams (
  id TEXT PRIMARY KEY CHECK (id LIKE 'stm_%'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL CHECK (template IN ('backlog_dev','code_health','security','help_desk','scheduling','email','digest','docs_changelog','incident','custom')),
  definition TEXT NOT NULL CHECK (json_valid(definition)),      -- stream-definition.json
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','degraded','archived')),
  default_tier TEXT NOT NULL DEFAULT 'L1' REFERENCES autonomy_tiers(tier),
  wip_limit INTEGER NOT NULL DEFAULT 2 CHECK (wip_limit >= 1),
  last_fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, key)
);
CREATE INDEX idx_streams_status ON streams(status, project_id);

CREATE TABLE ledger_rows (
  id TEXT PRIMARY KEY CHECK (id LIKE 'lr_%'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  stream_id TEXT REFERENCES streams(id),
  title TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  lane TEXT NOT NULL,
  size TEXT NOT NULL CHECK (size IN ('XS','S','M','L','XL')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ready','claimed','running','verifying','awaiting_approval','merging','watching','done','blocked','parked','regressed')),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('agent','owner')),   -- RACI "A": always exactly one
  owner_id TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links)),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  wave TEXT,                                                          -- Core: 'C0' | 'C1' | 'C2' milestone tag
  -- probe (measures a consequence, not an activity); Tier 0, human-owned, immutable in Core
  probe_revision INTEGER NOT NULL DEFAULT 1 CHECK (probe_revision >= 1),
  probe_kind TEXT NOT NULL CHECK (probe_kind IN ('command','http','sql_readonly','metric_threshold','file_assert','manual_attestation')),
  probe_spec TEXT NOT NULL CHECK (json_valid(probe_spec)),
  probe_expected TEXT NOT NULL CHECK (json_valid(probe_expected)),
  probe_measures TEXT NOT NULL CHECK (length(probe_measures) >= 10),
  probe_runs_against TEXT NOT NULL DEFAULT 'merged_artifact' CHECK (probe_runs_against IN ('branch','merged_artifact','deployed_artifact','external_state')),
  probe_hash TEXT NOT NULL CHECK (length(probe_hash) = 64),
  probe_trust_tier INTEGER NOT NULL DEFAULT 0 CHECK (probe_trust_tier = 0),
  premise_retested_at TEXT,
  premise_valid INTEGER CHECK (premise_valid IN (0,1)),
  merged_sha TEXT CHECK (merged_sha IS NULL OR length(merged_sha) = 40),
  last_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (last_probe_status IN ('never','pass','fail','error')),
  last_probe_at TEXT,
  evidence_bundle_id TEXT,
  watch_hours INTEGER NOT NULL DEFAULT 24 CHECK (watch_hours BETWEEN 0 AND 168),   -- Core default 24 (full: 48)
  watch_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE INDEX idx_ledger_status ON ledger_rows(project_id, status, priority);
CREATE INDEX idx_ledger_stream ON ledger_rows(stream_id, status);
CREATE INDEX idx_ledger_owner ON ledger_rows(owner_kind, owner_id, status);
CREATE INDEX idx_ledger_done_probe ON ledger_rows(status, last_probe_status) WHERE status IN ('done','watching');

CREATE TABLE work_orders (
  id TEXT PRIMARY KEY CHECK (id LIKE 'wo_%'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  stream_id TEXT NOT NULL REFERENCES streams(id),
  ledger_row_id TEXT NOT NULL REFERENCES ledger_rows(id),
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  base_commit TEXT CHECK (base_commit IS NULL OR length(base_commit) = 40),
  body TEXT NOT NULL CHECK (json_valid(body)),                  -- work-order.json (carries budget.caps)
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  autonomy_tier TEXT NOT NULL REFERENCES autonomy_tiers(tier),
  doer_agent_id TEXT REFERENCES agents(id),
  verifier_agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','running','completed','failed','expired','cancelled','superseded')),
  supersedes_id TEXT REFERENCES work_orders(id),
  issued_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (ledger_row_id, version),
  CHECK (status = 'draft' OR (issued_at IS NOT NULL AND expires_at IS NOT NULL)),         -- TTL on every order
  CHECK (verifier_agent_id IS NULL OR verifier_agent_id <> doer_agent_id)                  -- maker-checker
);
CREATE INDEX idx_wo_status ON work_orders(project_id, status);
CREATE INDEX idx_wo_row ON work_orders(ledger_row_id);

-- ----------------------------------------------------------------------------
-- Leases (one writer per artifact) and Grants (merge slot)
-- ----------------------------------------------------------------------------
CREATE TABLE leases (
  id TEXT PRIMARY KEY CHECK (id LIKE 'lse_%'),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('worktree','branch','stream','path','deploy_window','migration_lock')),
  resource_key TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired','revoked')),
  fence_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (expires_at > acquired_at)
);
-- one active holder per resource (single writer per artifact)
CREATE UNIQUE INDEX uq_lease_active ON leases(resource_kind, resource_key) WHERE status = 'active';
CREATE INDEX idx_lease_expiry ON leases(expires_at) WHERE status = 'active';

CREATE TABLE evidence_bundles (  -- immutable once written (declared before approvals/decision_cards that point at it)
  id TEXT PRIMARY KEY CHECK (id LIKE 'evb_%'),
  subject_kind TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_sha TEXT,
  body TEXT NOT NULL CHECK (json_valid(body)),                  -- evidence-bundle.json
  bundle_hash TEXT NOT NULL CHECK (length(bundle_hash) = 64),
  scan_red INTEGER NOT NULL DEFAULT 0 CHECK (scan_red IN (0,1)),
  rule_of_two_violated INTEGER NOT NULL DEFAULT 0 CHECK (rule_of_two_violated IN (0,1)),
  captured_by TEXT NOT NULL CHECK (captured_by IN ('ci_sandbox','kernel')),   -- never the agent
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_evidence_subject ON evidence_bundles(subject_kind, subject_ref);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY CHECK (id LIKE 'apr_%'),
  action_class TEXT NOT NULL REFERENCES action_classes(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  tier TEXT NOT NULL REFERENCES autonomy_tiers(tier),
  subject_kind TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  head_sha TEXT CHECK (head_sha IS NULL OR length(head_sha) = 40),
  evidence_bundle_id TEXT NOT NULL REFERENCES evidence_bundles(id),
  decision_card_id TEXT,
  requester_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','superseded','revoked','consumed')),
  request TEXT NOT NULL CHECK (json_valid(request)),            -- approval-request.json
  challenge_required INTEGER NOT NULL DEFAULT 0 CHECK (challenge_required IN (0,1)),
  challenge_kind TEXT CHECK (challenge_kind IN ('phrase','code')),
  challenge_commitment TEXT CHECK (challenge_commitment IS NULL OR length(challenge_commitment) = 64),
  challenge_channel TEXT,
  challenge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (challenge_attempts <= 3),
  step_up_required INTEGER NOT NULL DEFAULT 0 CHECK (step_up_required IN (0,1)),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  default_on_timeout TEXT NOT NULL DEFAULT 'deny' CHECK (default_on_timeout = 'deny'),
  decision TEXT CHECK (decision IN ('approved','denied','changes_requested')),
  approver_id TEXT CHECK (approver_id IS NULL OR approver_id LIKE 'own_%'),   -- only the Owner; agents are never 'own_%'
  method TEXT CHECK (method IN ('deck_click','deck_challenge_phrase','passkey','totp','hardware_key','cli_signed')),
  response TEXT CHECK (response IS NULL OR json_valid(response)),  -- approval-response.json
  response_payload_hash TEXT,
  responded_at TEXT,
  consumed_at TEXT,
  CHECK (challenge_required = 0 OR (challenge_kind IS NOT NULL AND challenge_commitment IS NOT NULL AND challenge_channel IS NOT NULL)),
  CHECK (status <> 'approved' OR (approver_id IS NOT NULL AND method IS NOT NULL AND responded_at IS NOT NULL AND response_payload_hash = payload_hash))
);
CREATE INDEX idx_approvals_status ON approvals(status, expires_at);
CREATE INDEX idx_approvals_subject ON approvals(subject_kind, subject_ref);
CREATE INDEX idx_approvals_approver ON approvals(approver_id, responded_at);

CREATE TABLE grants (
  id TEXT PRIMARY KEY CHECK (id LIKE 'grt_%'),
  kind TEXT NOT NULL CHECK (kind IN ('credential','merge_slot','deploy_window','migration_lock','spend','tool_scope')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_agent_id TEXT REFERENCES agents(id),
  work_order_id TEXT REFERENCES work_orders(id),
  run_id TEXT,
  resource_kind TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  approval_id TEXT REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','consumed','expired','revoked','void')),
  single_use INTEGER NOT NULL DEFAULT 1 CHECK (single_use IN (0,1)),
  bound_hash TEXT CHECK (bound_hash IS NULL OR length(bound_hash) = 64),
  -- merge slot fields
  pr_host TEXT, pr_repo TEXT, pr_number INTEGER, pr_url TEXT,
  base_branch TEXT,
  base_sha_at_grant TEXT CHECK (base_sha_at_grant IS NULL OR length(base_sha_at_grant) = 40),
  approved_head_sha TEXT CHECK (approved_head_sha IS NULL OR length(approved_head_sha) = 40),
  observed_head_sha TEXT CHECK (observed_head_sha IS NULL OR length(observed_head_sha) = 40),
  queue_position INTEGER,
  conflict_check TEXT CHECK (conflict_check IS NULL OR json_valid(conflict_check)),
  issued_at TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind <> 'merge_slot' OR (approved_head_sha IS NOT NULL AND pr_number IS NOT NULL AND pr_repo IS NOT NULL AND base_branch IS NOT NULL)),
  CHECK (kind NOT IN ('merge_slot','deploy_window','migration_lock','spend') OR status = 'pending' OR approval_id IS NOT NULL),
  CHECK (status NOT IN ('active','consumed') OR issued_at IS NOT NULL)
);
-- exactly one live merge slot per project+base branch: serializes landings
CREATE UNIQUE INDEX uq_merge_slot_active ON grants(project_id, base_branch) WHERE kind = 'merge_slot' AND status = 'active';
CREATE INDEX idx_grants_status ON grants(status, expires_at);
CREATE INDEX idx_grants_slot_queue ON grants(project_id, base_branch, queue_position) WHERE kind = 'merge_slot' AND status = 'pending';
-- Core addition (an index only, no new column): an approval can back at most one live or used merge slot
CREATE UNIQUE INDEX uq_grants_one_per_approval ON grants(approval_id) WHERE kind = 'merge_slot' AND approval_id IS NOT NULL AND status IN ('pending','active','consumed');

-- ----------------------------------------------------------------------------
-- Runs
-- ----------------------------------------------------------------------------
CREATE TABLE runs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'run_%'),
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  stream_id TEXT NOT NULL REFERENCES streams(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_run_id TEXT REFERENCES runs(id),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  adapter_name TEXT NOT NULL,
  adapter_vendor TEXT NOT NULL CHECK (adapter_vendor IN ('anthropic','openai','google','local','other')),
  adapter_version TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','starting','running','paused','validating','succeeded','failed','timed_out','killed','cancelled')),
  session_id TEXT,                                               -- stored per work item for resume
  lease_id TEXT REFERENCES leases(id),
  workspace_path TEXT,
  branch TEXT,
  input_hash TEXT CHECK (input_hash IS NULL OR length(input_hash) = 64),
  result TEXT CHECK (result IS NULL OR json_valid(result)),     -- run-result.json
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  exit_code INTEGER,
  failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('adapter','schema','no_artifact','claim_mismatch','nonzero_exit','timeout','budget','killed','cancelled','policy')),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT, ended_at TEXT, deadline_at TEXT,
  UNIQUE (work_order_id, attempt)
);
CREATE INDEX idx_runs_status ON runs(status, project_id);
CREATE INDEX idx_runs_agent ON runs(agent_id, started_at);
CREATE INDEX idx_runs_wo ON runs(work_order_id);

CREATE TABLE run_steps (  -- append-only journal of a run (prompt, turns, tool calls by hash, checkpoints)
  id TEXT PRIMARY KEY CHECK (id LIKE 'stp_%'),
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('prompt','model_turn','tool_call','tool_result','checkpoint','stop_request','escalation','human_input')),
  content_ref TEXT, content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT,
  UNIQUE (run_id, seq)
);

CREATE TABLE run_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('pull_request','commit','message_id','file','report','deploy','calendar_hold','ticket_reply','email_draft')),
  ref TEXT NOT NULL,
  sha TEXT,
  claimed_by_agent INTEGER NOT NULL DEFAULT 1 CHECK (claimed_by_agent IN (0,1)),
  verified_by_kernel INTEGER NOT NULL DEFAULT 0 CHECK (verified_by_kernel IN (0,1)),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, kind, ref)
);

-- ----------------------------------------------------------------------------
-- Decisions and reports
-- ----------------------------------------------------------------------------
CREATE TABLE decision_cards (
  id TEXT PRIMARY KEY CHECK (id LIKE 'dcd_%'),
  variant TEXT NOT NULL CHECK (variant IN ('approve','choose','answer','review','unblock')),
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  ask TEXT NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('now','today','this_week','whenever')),
  deadline_at TEXT,
  default_on_timeout TEXT NOT NULL,
  approval_id TEXT REFERENCES approvals(id),
  evidence_bundle_id TEXT REFERENCES evidence_bundles(id),
  body TEXT NOT NULL CHECK (json_valid(body)),                  -- decision-card.json
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','answered','expired','withdrawn')),
  answer TEXT CHECK (answer IS NULL OR json_valid(answer)),
  answered_by TEXT CHECK (answered_by IS NULL OR answered_by LIKE 'own_%'),
  answered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (variant <> 'approve' OR approval_id IS NOT NULL)
);
CREATE INDEX idx_cards_open ON decision_cards(status, urgency, deadline_at);

CREATE TABLE status_reports (   -- the Dawn Log digest and run summaries
  id TEXT PRIMARY KEY CHECK (id LIKE 'rpt_%'),
  reporter_agent_id TEXT NOT NULL REFERENCES agents(id),
  project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly','on_change','run')),
  period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),                  -- status-report.json
  data_as_of TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE spend_entries (  -- append-only
  id TEXT PRIMARY KEY CHECK (id LIKE 'spd_%'),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  project_id TEXT REFERENCES projects(id),
  stream_id TEXT REFERENCES streams(id),
  run_id TEXT REFERENCES runs(id),
  agent_id TEXT REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('model_tokens','sandbox_time','api','real_money')),
  vendor TEXT, model TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL CHECK (usd >= 0),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_spend_ts ON spend_entries(ts);
CREATE INDEX idx_spend_scope ON spend_entries(project_id, stream_id, ts);
CREATE INDEX idx_spend_run ON spend_entries(run_id);

CREATE VIEW budget_usage AS
SELECT b.id AS budget_id, b.scope_kind, b.scope_id, b.period, b.max_usd,
  (SELECT COALESCE(SUM(s.usd),0) FROM spend_entries s
    WHERE ((b.scope_kind='fleet') OR (b.scope_kind='project' AND s.project_id=b.scope_id)
       OR (b.scope_kind='stream' AND s.stream_id=b.scope_id) OR (b.scope_kind='agent' AND s.agent_id=b.scope_id)
       OR (b.scope_kind='run' AND s.run_id=b.scope_id))
      AND (b.period IN ('run','ttl')
       OR (b.period='day' AND s.ts >= strftime('%Y-%m-%dT00:00:00Z','now'))
       OR (b.period='week' AND s.ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days'))
       OR (b.period='month' AND s.ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')))) AS spent_usd
FROM budgets b;

-- ----------------------------------------------------------------------------
-- Event log (append-only, hash-chained)
-- hash = sha256( prev_hash || "\n" || canonical_json(envelope without 'hash') ), genesis prev_hash = 64 zeros.
-- The DB enforces gapless seq and prev_hash == head hash; `fw audit verify` recomputes every hash.
-- ----------------------------------------------------------------------------
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,                                       -- gapless: trigger enforces max(seq)+1
  id TEXT NOT NULL UNIQUE CHECK (id LIKE 'evt_%'),
  ts TEXT NOT NULL,
  type TEXT NOT NULL REFERENCES event_types(type),               -- closed union: unknown types are rejected
  version INTEGER NOT NULL DEFAULT 1,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system','adapter')),
  actor_id TEXT NOT NULL,
  project_id TEXT, stream_id TEXT, work_order_id TEXT, run_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  UNIQUE (type, idempotency_key)
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_type ON events(type, seq);
CREATE INDEX idx_events_run ON events(run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX idx_events_wo ON events(work_order_id, seq) WHERE work_order_id IS NOT NULL;
CREATE INDEX idx_events_project ON events(project_id, seq) WHERE project_id IS NOT NULL;
CREATE INDEX idx_events_corr ON events(correlation_id);

-- ----------------------------------------------------------------------------
-- Policy and settings (Tier 0)
-- ----------------------------------------------------------------------------
CREATE TABLE policy_rules (
  id TEXT NOT NULL CHECK (id LIKE 'pol_%'),
  version INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 10000),    -- lower runs first; deny wins ties
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny','ask','escalate','require_challenge','cap_tier')),
  match TEXT NOT NULL CHECK (json_valid(match)),                     -- policy-rule.json#match
  tier TEXT REFERENCES autonomy_tiers(tier),
  cap_tier TEXT REFERENCES autonomy_tiers(tier),
  reason TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  trust_tier INTEGER NOT NULL DEFAULT 0 CHECK (trust_tier = 0),
  rule_hash TEXT NOT NULL CHECK (length(rule_hash) = 64),
  effective_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL CHECK (created_by LIKE 'own_%'),
  second_owner_ack TEXT CHECK (second_owner_ack IS NULL OR second_owner_ack LIKE 'own_%'),
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_policy_active ON policy_rules(enabled, priority);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  trust_tier INTEGER NOT NULL DEFAULT 1 CHECK (trust_tier IN (0,1,2)),
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (trust_tier <> 0 OR updated_by LIKE 'own_%')            -- Tier 0 settings: the Owner only
);

-- ============================================================================
-- TRIGGERS  (the safety properties that must hold even if the daemon has a bug)
-- ============================================================================

-- --- 1. Append-only tables ---------------------------------------------------
CREATE TRIGGER trg_events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only: UPDATE forbidden'); END;
CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only: DELETE forbidden'); END;
CREATE TRIGGER trg_run_steps_no_update BEFORE UPDATE ON run_steps
BEGIN SELECT RAISE(ABORT, 'run_steps is append-only: UPDATE forbidden'); END;
CREATE TRIGGER trg_run_steps_no_delete BEFORE DELETE ON run_steps
BEGIN SELECT RAISE(ABORT, 'run_steps is append-only: DELETE forbidden'); END;
CREATE TRIGGER trg_spend_entries_no_update BEFORE UPDATE ON spend_entries
BEGIN SELECT RAISE(ABORT, 'spend_entries is append-only: UPDATE forbidden'); END;
CREATE TRIGGER trg_spend_entries_no_delete BEFORE DELETE ON spend_entries
BEGIN SELECT RAISE(ABORT, 'spend_entries is append-only: DELETE forbidden'); END;
CREATE TRIGGER trg_evidence_bundles_no_update BEFORE UPDATE ON evidence_bundles
BEGIN SELECT RAISE(ABORT, 'evidence_bundles is append-only: UPDATE forbidden'); END;
CREATE TRIGGER trg_evidence_bundles_no_delete BEFORE DELETE ON evidence_bundles
BEGIN SELECT RAISE(ABORT, 'evidence_bundles is append-only: DELETE forbidden'); END;

-- --- 2. Hash chain: gapless seq and prev_hash must equal the current head ----
CREATE TRIGGER trg_events_chain BEFORE INSERT ON events
BEGIN
  SELECT RAISE(ABORT, 'events: seq must be max(seq)+1')
    WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM events), 0) + 1;
  SELECT RAISE(ABORT, 'events: prev_hash must equal head hash (genesis = 64 zeros)')
    WHERE NEW.prev_hash <> COALESCE((SELECT hash FROM events ORDER BY seq DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000');
END;

-- Defence in depth for "secrets never in model context or logs": redaction happens in the
-- daemon BEFORE the write; this tripwire refuses a payload that still looks like a secret.
-- (A refusal is itself a signal: the daemon logs system.health_degraded without the payload.)
CREATE TRIGGER trg_events_no_secret_shapes BEFORE INSERT ON events
WHEN NEW.payload GLOB '*sk-ant-*' OR NEW.payload GLOB '*sk-proj-*' OR NEW.payload GLOB '*ghp_[A-Za-z0-9]*'
  OR NEW.payload GLOB '*github_pat_*' OR NEW.payload GLOB '*AKIA[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]*'
  OR NEW.payload GLOB '*xox[bp]-*' OR NEW.payload GLOB '*BEGIN *PRIVATE KEY*'
BEGIN SELECT RAISE(ABORT, 'events: payload contains a secret-shaped token; redact before write'); END;

-- --- 3. State machine guards (legal_transitions is seeded from STATE-MACHINES.md) --
CREATE TRIGGER trg_ledger_rows_transition BEFORE UPDATE OF status ON ledger_rows
WHEN OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'illegal ledger_row transition')
    WHERE NOT EXISTS (SELECT 1 FROM legal_transitions WHERE machine = 'ledger_row' AND from_state = OLD.status AND to_state = NEW.status);
END;
CREATE TRIGGER trg_work_orders_transition BEFORE UPDATE OF status ON work_orders
WHEN OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'illegal work_order transition')
    WHERE NOT EXISTS (SELECT 1 FROM legal_transitions WHERE machine = 'work_order' AND from_state = OLD.status AND to_state = NEW.status);
END;
CREATE TRIGGER trg_runs_transition BEFORE UPDATE OF status ON runs
WHEN OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'illegal run transition')
    WHERE NOT EXISTS (SELECT 1 FROM legal_transitions WHERE machine = 'run' AND from_state = OLD.status AND to_state = NEW.status);
END;
CREATE TRIGGER trg_approvals_transition BEFORE UPDATE OF status ON approvals
WHEN OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'illegal approval transition')
    WHERE NOT EXISTS (SELECT 1 FROM legal_transitions WHERE machine = 'approval' AND from_state = OLD.status AND to_state = NEW.status);
END;
CREATE TRIGGER trg_grants_transition BEFORE UPDATE OF status ON grants
WHEN OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'illegal grant transition')
    WHERE NOT EXISTS (SELECT 1 FROM legal_transitions WHERE machine = 'grant' AND from_state = OLD.status AND to_state = NEW.status);
END;

-- --- 4. Ledger: probes, premise, definition of done ---------------------------
-- Core: a probe never changes. To change one, park the row and create a superseding row
-- (the full schema adds ledger_probe_revisions and an Owner-approved revision path).
CREATE TRIGGER trg_ledger_probe_immutable BEFORE UPDATE OF probe_kind, probe_spec, probe_expected, probe_measures, probe_runs_against, probe_hash, probe_revision ON ledger_rows
WHEN NEW.probe_hash <> OLD.probe_hash OR NEW.probe_revision <> OLD.probe_revision OR NEW.probe_spec <> OLD.probe_spec
  OR NEW.probe_expected <> OLD.probe_expected OR NEW.probe_kind <> OLD.probe_kind OR NEW.probe_measures <> OLD.probe_measures
  OR NEW.probe_runs_against <> OLD.probe_runs_against
BEGIN SELECT RAISE(ABORT, 'ledger_rows: probe is immutable in Core; park this row and add a superseding row'); END;

CREATE TRIGGER trg_ledger_no_delete BEFORE DELETE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows: rows are never deleted; park or close them'); END;

-- "Every probe fails today": a row is workable only when its premise was re-tested and the
-- probe FAILED against the current base (a probe that already passes measures nothing).
CREATE TRIGGER trg_ledger_ready_requires_failing_probe BEFORE UPDATE OF status ON ledger_rows
WHEN NEW.status = 'ready' AND OLD.status <> 'ready'
BEGIN
  SELECT RAISE(ABORT, 'ledger_rows: ready requires premise_valid=1 (premise re-tested and still true)')
    WHERE NEW.premise_valid IS NOT 1 OR NEW.premise_retested_at IS NULL;
  SELECT RAISE(ABORT, 'ledger_rows: ready requires last_probe_status=fail (probe must fail today)')
    WHERE NEW.last_probe_status <> 'fail';
END;

-- Definition of done, machine-checkable: a probe pass, a kernel-captured evidence bundle for
-- the merged SHA with no red scan, and (after merge) an elapsed watch window.
CREATE TRIGGER trg_ledger_done_requires_proof BEFORE UPDATE OF status ON ledger_rows
WHEN NEW.status = 'done' AND OLD.status <> 'done'
BEGIN
  SELECT RAISE(ABORT, 'ledger_rows: done requires last_probe_status=pass')
    WHERE NEW.last_probe_status <> 'pass';
  SELECT RAISE(ABORT, 'ledger_rows: done requires an evidence_bundle_id')
    WHERE NEW.evidence_bundle_id IS NULL;
  SELECT RAISE(ABORT, 'ledger_rows: evidence bundle must be kernel- or CI-captured, green, and bound to the merged SHA')
    WHERE NOT EXISTS (SELECT 1 FROM evidence_bundles e WHERE e.id = NEW.evidence_bundle_id AND e.scan_red = 0
                      AND (NEW.merged_sha IS NULL OR e.subject_sha = NEW.merged_sha));
  SELECT RAISE(ABORT, 'ledger_rows: done after watching requires watch window elapsed')
    WHERE OLD.status = 'watching' AND (NEW.watch_until IS NULL OR NEW.watch_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Landing needs the single merge slot; watching needs the slot to have been consumed.
CREATE TRIGGER trg_ledger_merging_requires_slot BEFORE UPDATE OF status ON ledger_rows
WHEN NEW.status = 'merging' AND OLD.status <> 'merging'
BEGIN
  SELECT RAISE(ABORT, 'ledger_rows: merging requires an active merge_slot grant for this row')
    WHERE NOT EXISTS (SELECT 1 FROM grants g JOIN work_orders w ON w.id = g.work_order_id
                      WHERE w.ledger_row_id = NEW.id AND g.kind = 'merge_slot' AND g.status = 'active');
END;
CREATE TRIGGER trg_ledger_watching_requires_landing BEFORE UPDATE OF status ON ledger_rows
WHEN NEW.status = 'watching' AND OLD.status <> 'watching'
BEGIN
  SELECT RAISE(ABORT, 'ledger_rows: watching requires merged_sha')
    WHERE NEW.merged_sha IS NULL;
  SELECT RAISE(ABORT, 'ledger_rows: watching requires a consumed merge_slot grant (the merge actually landed)')
    WHERE NOT EXISTS (SELECT 1 FROM grants g JOIN work_orders w ON w.id = g.work_order_id
                      WHERE w.ledger_row_id = NEW.id AND g.kind = 'merge_slot' AND g.status = 'consumed');
END;

CREATE TRIGGER trg_ledger_touch AFTER UPDATE ON ledger_rows
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ledger_rows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

-- --- 5. Work orders: immutable once issued; maker and checker are different agents ---
CREATE TRIGGER trg_wo_body_immutable BEFORE UPDATE OF body, content_hash, autonomy_tier, ledger_row_id, version ON work_orders
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'work_orders: an issued order is immutable; supersede it with a new version'); END;

CREATE TRIGGER trg_wo_issue_gate BEFORE UPDATE OF status ON work_orders
WHEN NEW.status = 'issued' AND OLD.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'work_orders: issue requires a doer agent that is active')
    WHERE NEW.doer_agent_id IS NULL OR (SELECT status FROM agents WHERE id = NEW.doer_agent_id) <> 'active';
  SELECT RAISE(ABORT, 'work_orders: autonomy tier exceeds the doer agent tier')
    WHERE (SELECT rank FROM autonomy_tiers WHERE tier = NEW.autonomy_tier) > (SELECT rank FROM autonomy_tiers WHERE tier = (SELECT tier FROM agents WHERE id = NEW.doer_agent_id));
  SELECT RAISE(ABORT, 'work_orders: the doer must have role worker')
    WHERE (SELECT role FROM agents WHERE id = NEW.doer_agent_id) <> 'worker';
  SELECT RAISE(ABORT, 'work_orders: a verifier, when named, must be an active agent with role verifier')
    WHERE NEW.verifier_agent_id IS NOT NULL
      AND (SELECT COUNT(*) FROM agents WHERE id = NEW.verifier_agent_id AND role = 'verifier' AND status = 'active') = 0;
  SELECT RAISE(ABORT, 'work_orders: the ledger row must be claimed to issue an order')
    WHERE (SELECT status FROM ledger_rows WHERE id = NEW.ledger_row_id) NOT IN ('ready','claimed');
END;

-- --- 6. Runs: kill switch, budget admission, one writer, no self-verification -------
CREATE TRIGGER trg_runs_no_self_verify BEFORE INSERT ON runs
BEGIN
  SELECT RAISE(ABORT, 'runs: a verifier may not run on its own work order as doer')
    WHERE (SELECT role FROM agents WHERE id = NEW.agent_id) = 'verifier'
      AND NEW.agent_id = (SELECT doer_agent_id FROM work_orders WHERE id = NEW.work_order_id);
  SELECT RAISE(ABORT, 'runs: the verifier role may only be run by the work order''s named verifier')
    WHERE (SELECT role FROM agents WHERE id = NEW.agent_id) = 'verifier'
      AND NEW.agent_id IS NOT (SELECT verifier_agent_id FROM work_orders WHERE id = NEW.work_order_id);
  SELECT RAISE(ABORT, 'runs: a worker run must be by the work order''s doer')
    WHERE (SELECT role FROM agents WHERE id = NEW.agent_id) = 'worker'
      AND NEW.agent_id IS NOT (SELECT doer_agent_id FROM work_orders WHERE id = NEW.work_order_id);
END;

CREATE TRIGGER trg_runs_kill_switch_insert BEFORE INSERT ON runs
BEGIN
  SELECT RAISE(ABORT, 'runs: kill switch is engaged; no new runs')
    WHERE COALESCE((SELECT json_extract(value,'$.engaged') FROM settings WHERE key = 'kill_switch'), 0) = 1;
END;

-- Admission (queued -> starting): kill switch off, budgets not exhausted, live lease held,
-- work order still valid. This is the "single writer per artifact" and "budget hard stop" gate.
CREATE TRIGGER trg_runs_admission BEFORE UPDATE OF status ON runs
WHEN NEW.status = 'starting' AND OLD.status = 'queued'
BEGIN
  SELECT RAISE(ABORT, 'runs: kill switch is engaged; no new runs')
    WHERE COALESCE((SELECT json_extract(value,'$.engaged') FROM settings WHERE key = 'kill_switch'), 0) = 1;
  SELECT RAISE(ABORT, 'runs: budget exhausted (hard stop); dispatch refused')
    WHERE EXISTS (SELECT 1 FROM budget_usage u
                  WHERE u.max_usd IS NOT NULL AND u.spent_usd >= u.max_usd AND u.period <> 'run'
                    AND (u.scope_kind = 'fleet'
                         OR (u.scope_kind = 'project' AND u.scope_id = NEW.project_id)
                         OR (u.scope_kind = 'stream'  AND u.scope_id = NEW.stream_id)
                         OR (u.scope_kind = 'agent'   AND u.scope_id = NEW.agent_id)));
  SELECT RAISE(ABORT, 'runs: starting requires an active lease (one writer per artifact)')
    WHERE NEW.lease_id IS NULL OR (SELECT status FROM leases WHERE id = NEW.lease_id) IS NOT 'active';
  SELECT RAISE(ABORT, 'runs: the lease must be held by this run''s agent')
    WHERE (SELECT holder_agent_id FROM leases WHERE id = NEW.lease_id) IS NOT NEW.agent_id;
  SELECT RAISE(ABORT, 'runs: the work order is not issued/running or has expired')
    WHERE (SELECT status FROM work_orders WHERE id = NEW.work_order_id) NOT IN ('issued','running')
       OR (SELECT expires_at FROM work_orders WHERE id = NEW.work_order_id) <= strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;

-- "completed" is not evidence: succeeded requires a kernel-verified artifact.
CREATE TRIGGER trg_runs_succeeded_requires_artifact BEFORE UPDATE OF status ON runs
WHEN NEW.status = 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'runs: succeeded requires >=1 kernel-verified artifact (an agent saying "completed" is not evidence)')
    WHERE NOT EXISTS (SELECT 1 FROM run_artifacts a WHERE a.run_id = NEW.id AND a.verified_by_kernel = 1);
  SELECT RAISE(ABORT, 'runs: succeeded requires result_hash and exit_code=0')
    WHERE NEW.result_hash IS NULL OR NEW.exit_code IS NOT 0;
END;

-- Leases: monotonically increasing fence token per resource (a stale holder can be fenced off).
CREATE TRIGGER trg_leases_fence_monotonic BEFORE INSERT ON leases
BEGIN
  SELECT RAISE(ABORT, 'leases: fence_token must exceed every earlier token for this resource')
    WHERE NEW.fence_token <= COALESCE((SELECT MAX(fence_token) FROM leases WHERE resource_kind = NEW.resource_kind AND resource_key = NEW.resource_key), 0);
END;
CREATE TRIGGER trg_leases_kill_switch BEFORE INSERT ON leases
BEGIN
  SELECT RAISE(ABORT, 'leases: kill switch is engaged; no new leases')
    WHERE COALESCE((SELECT json_extract(value,'$.engaged') FROM settings WHERE key = 'kill_switch'), 0) = 1;
END;

-- --- 7. Budgets: hard stop on spend; only the Owner changes caps ---------------
-- Every spend entry is re-evaluated: a run over its work-order cap, or any run inside an
-- exhausted fleet/project/stream/agent budget, is killed in the same transaction.
CREATE TRIGGER trg_spend_hard_stop AFTER INSERT ON spend_entries
BEGIN
  UPDATE runs SET status = 'killed', failure_class = 'budget', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE status IN ('running','paused')
    AND (
      (id = NEW.run_id
       AND (SELECT SUM(s.usd) FROM spend_entries s WHERE s.run_id = NEW.run_id)
           > COALESCE((SELECT json_extract(w.body,'$.budget.caps.max_usd') FROM work_orders w WHERE w.id = runs.work_order_id), 1e18))
      OR EXISTS (SELECT 1 FROM budget_usage u
                 WHERE u.max_usd IS NOT NULL AND u.spent_usd >= u.max_usd AND u.period <> 'run'
                   AND (u.scope_kind = 'fleet'
                        OR (u.scope_kind = 'project' AND u.scope_id = runs.project_id)
                        OR (u.scope_kind = 'stream'  AND u.scope_id = runs.stream_id)
                        OR (u.scope_kind = 'agent'   AND u.scope_id = runs.agent_id)))
    );
END;

CREATE TRIGGER trg_budgets_human_only BEFORE UPDATE OF max_usd, max_tokens, max_minutes, max_turns, set_by ON budgets
WHEN NEW.set_by = OLD.set_by AND NEW.version = OLD.version
BEGIN SELECT RAISE(ABORT, 'budgets: a change must bump version and record the Owner who set it'); END;
CREATE TRIGGER trg_budgets_owner_is_owner BEFORE INSERT ON budgets
BEGIN
  SELECT RAISE(ABORT, 'budgets: set_by must be the configured Owner')
    WHERE NEW.set_by IS NOT json_extract((SELECT value FROM settings WHERE key = 'owner'), '$.id');
END;

-- --- 8. Approvals: hash binding, Owner only, evidence-bound, single consumption ---
CREATE TRIGGER trg_approvals_request_gate BEFORE INSERT ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals: a pending approval may not carry a decision')
    WHERE NEW.status <> 'pending' OR NEW.decision IS NOT NULL;
  SELECT RAISE(ABORT, 'approvals: a red-scan evidence bundle cannot be put up for approval')
    WHERE (SELECT scan_red FROM evidence_bundles WHERE id = NEW.evidence_bundle_id) = 1;
  -- merge approvals: the evidence is for THIS head, and an independent reviewer (never the doer) did not reject
  SELECT RAISE(ABORT, 'approvals: merge evidence must be bound to the approval head_sha')
    WHERE NEW.action_class = 'merge_main'
      AND (NEW.head_sha IS NULL OR NEW.head_sha IS NOT (SELECT subject_sha FROM evidence_bundles WHERE id = NEW.evidence_bundle_id));
  SELECT RAISE(ABORT, 'approvals: merge evidence needs an independent_check by a reviewer other than the doer, not rejecting')
    WHERE NEW.action_class = 'merge_main'
      AND ( (SELECT json_extract(body,'$.independent_check.reviewer_agent_id') FROM evidence_bundles WHERE id = NEW.evidence_bundle_id) IS NULL
         OR (SELECT json_extract(body,'$.independent_check.reviewer_agent_id') FROM evidence_bundles WHERE id = NEW.evidence_bundle_id)
              IS (SELECT doer_agent_id FROM work_orders WHERE id = json_extract(NEW.request,'$.work_order_id'))
         OR (SELECT json_extract(body,'$.independent_check.verdict') FROM evidence_bundles WHERE id = NEW.evidence_bundle_id) = 'reject' );
END;

CREATE TRIGGER trg_approvals_respond BEFORE UPDATE OF status ON approvals
WHEN NEW.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approvals: response payload hash does not match the request')
    WHERE NEW.response_payload_hash IS NOT OLD.payload_hash;
  SELECT RAISE(ABORT, 'approvals: approval expired before response')
    WHERE NEW.responded_at > OLD.expires_at;
  SELECT RAISE(ABORT, 'approvals: approver is not the configured Owner')
    WHERE NEW.approver_id IS NOT json_extract((SELECT value FROM settings WHERE key = 'owner'), '$.id');
  SELECT RAISE(ABORT, 'approvals: challenge required but not satisfied')
    WHERE OLD.challenge_required = 1 AND (NEW.method NOT IN ('deck_challenge_phrase','cli_signed') OR NEW.challenge_attempts > 3);
  SELECT RAISE(ABORT, 'approvals: step-up required but method is a plain click')
    WHERE OLD.step_up_required = 1 AND NEW.method = 'deck_click';
  SELECT RAISE(ABORT, 'approvals: evidence bundle with a red scan cannot be approved')
    WHERE (SELECT scan_red FROM evidence_bundles WHERE id = OLD.evidence_bundle_id) = 1;
  SELECT RAISE(ABORT, 'approvals: kill switch is engaged')
    WHERE COALESCE((SELECT json_extract(value,'$.engaged') FROM settings WHERE key = 'kill_switch'), 0) = 1;
END;

CREATE TRIGGER trg_approvals_immutable_payload BEFORE UPDATE OF payload_hash, head_sha, subject_ref, action_class, environment, requester_agent_id, evidence_bundle_id ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals: bound payload is immutable; mint a new approval'); END;

CREATE TRIGGER trg_approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals: never deleted'); END;

-- --- 9. Grants / merge slot ---------------------------------------------------
-- Head SHA change voids the slot, and the approval that backed it can never be reused.
CREATE TRIGGER trg_merge_slot_head_change AFTER UPDATE OF observed_head_sha ON grants
WHEN NEW.kind = 'merge_slot' AND NEW.status IN ('pending','active') AND NEW.observed_head_sha IS NOT NULL AND NEW.observed_head_sha <> NEW.approved_head_sha
BEGIN
  UPDATE grants SET status = 'void', void_reason = 'head_sha_changed' WHERE id = NEW.id;
END;

CREATE TRIGGER trg_grants_activate BEFORE UPDATE OF status ON grants
WHEN NEW.status = 'active' AND OLD.status = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'grants: activation requires an approved, unconsumed approval for gated kinds')
    WHERE NEW.kind IN ('merge_slot','deploy_window','migration_lock','spend')
      AND (SELECT status FROM approvals WHERE id = NEW.approval_id) IS NOT 'approved';
  SELECT RAISE(ABORT, 'grants: merge slot approved head SHA must equal the approval head_sha')
    WHERE NEW.kind = 'merge_slot' AND NEW.approved_head_sha IS NOT (SELECT head_sha FROM approvals WHERE id = NEW.approval_id);
  SELECT RAISE(ABORT, 'grants: grant is past expiry')
    WHERE NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now');
  SELECT RAISE(ABORT, 'grants: kill switch is engaged')
    WHERE COALESCE((SELECT json_extract(value,'$.engaged') FROM settings WHERE key = 'kill_switch'), 0) = 1;
END;

-- Consumption: only against a live approval, and only if the observed head still equals the approved head.
CREATE TRIGGER trg_grants_consume BEFORE UPDATE OF status ON grants
WHEN NEW.status = 'consumed' AND OLD.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'grants: consume requires the backing approval to still be approved (not consumed, superseded or revoked)')
    WHERE NEW.approval_id IS NOT NULL AND (SELECT status FROM approvals WHERE id = NEW.approval_id) IS NOT 'approved';
  SELECT RAISE(ABORT, 'grants: head SHA moved since approval; the merge may not land')
    WHERE NEW.kind = 'merge_slot' AND NEW.observed_head_sha IS NOT NULL AND NEW.observed_head_sha <> NEW.approved_head_sha;
END;

CREATE TRIGGER trg_grants_immutable_binding BEFORE UPDATE OF kind, approved_head_sha, pr_number, pr_repo, base_branch, approval_id, subject_agent_id ON grants
BEGIN SELECT RAISE(ABORT, 'grants: binding is immutable; issue a new grant'); END;

-- Approval lifecycle follows its grant: consumed with it, superseded when voided, revoked when revoked.
CREATE TRIGGER trg_grants_cascade_to_approval AFTER UPDATE OF status ON grants
WHEN NEW.approval_id IS NOT NULL AND NEW.status IN ('consumed','void','revoked')
BEGIN
  UPDATE approvals SET status = 'consumed', consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = NEW.approval_id AND status = 'approved' AND NEW.status = 'consumed';
  UPDATE approvals SET status = 'superseded'
    WHERE id = NEW.approval_id AND status = 'approved' AND NEW.status = 'void';
  UPDATE approvals SET status = 'revoked'
    WHERE id = NEW.approval_id AND status = 'approved' AND NEW.status = 'revoked';
END;

-- --- 10. Settings, kill switch -------------------------------------------------
-- Engaging may be done by the Owner or by the system (a breaker, a failed chain check).
-- Releasing is the Owner only. Engaging cascades inside the same transaction, so the kill
-- switch halts runs, leases, grants and pending approvals even if the daemon is wedged.
CREATE TRIGGER trg_kill_switch_release_owner_only BEFORE UPDATE ON settings
WHEN NEW.key = 'kill_switch' AND json_extract(OLD.value,'$.engaged') = 1 AND COALESCE(json_extract(NEW.value,'$.engaged'),0) = 0
BEGIN
  SELECT RAISE(ABORT, 'kill switch: only the Owner may release it')
    WHERE NEW.updated_by NOT LIKE 'own_%';
END;

CREATE TRIGGER trg_kill_switch_cascade AFTER UPDATE ON settings
WHEN NEW.key = 'kill_switch' AND json_extract(NEW.value,'$.engaged') = 1 AND COALESCE(json_extract(OLD.value,'$.engaged'),0) <> 1
BEGIN
  UPDATE runs SET status = 'killed', failure_class = 'killed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE status IN ('running','paused');
  UPDATE runs SET status = 'cancelled', failure_class = 'cancelled', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE status IN ('queued','starting');
  UPDATE leases SET status = 'revoked', released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'active';
  UPDATE grants SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = 'kill_switch'
    WHERE status IN ('pending','active');
  UPDATE approvals SET status = 'revoked' WHERE status IN ('pending','approved');
END;

-- --- 11. Policy rules: versions are immutable, never deleted -----------------------
CREATE TRIGGER trg_policy_rules_immutable BEFORE UPDATE ON policy_rules
BEGIN SELECT RAISE(ABORT, 'policy_rules: versions are immutable; insert a new version'); END;
CREATE TRIGGER trg_policy_rules_no_delete BEFORE DELETE ON policy_rules
BEGIN SELECT RAISE(ABORT, 'policy_rules: never deleted'); END;
CREATE TRIGGER trg_policy_rules_owner_is_owner BEFORE INSERT ON policy_rules
BEGIN
  SELECT RAISE(ABORT, 'policy_rules: created_by must be the configured Owner')
    WHERE NEW.created_by IS NOT json_extract((SELECT value FROM settings WHERE key = 'owner'), '$.id');
END;

-- --- 12. Decision cards: only the Owner answers --------------------------------
CREATE TRIGGER trg_cards_answer_owner_only BEFORE UPDATE OF status ON decision_cards
WHEN NEW.status = 'answered'
BEGIN
  SELECT RAISE(ABORT, 'decision_cards: answered_by must be the configured Owner')
    WHERE NEW.answered_by IS NOT json_extract((SELECT value FROM settings WHERE key = 'owner'), '$.id');
END;

-- ============================================================================
-- SEED DATA
-- ============================================================================
INSERT INTO autonomy_tiers(tier,rank,name,agent_may,human_role,requires_gate) VALUES
 ('L0',0,'Observe','Read-only; report and recommend','None required',0),
 ('L1',1,'Draft','Prepare artifacts (PR draft, email draft, plan) but not send, merge or apply','Human performs the action',0),
 ('L2',2,'Act in sandbox','Execute freely in disposable environments with no production credentials','Reviews results',0),
 ('L3',3,'Act with approval','Perform the real action after a gate with evidence, step-up and hash-bound approval','Approves each action',1),
 ('L4',4,'Act with notification','Perform the real action, notify immediately, undo window, sampled post-hoc review','Can reverse',0),
 ('L5',5,'Autonomous','Act within a policy envelope; periodic digests','Exception-based oversight',0);

INSERT INTO environments(id,description) VALUES
 ('sandbox','Disposable worktree/container, no production credentials'),
 ('staging','Pre-production or non-customer-facing real systems'),
 ('production','Real systems, real recipients, real money');

-- Core subset of the 23 full-plan action classes (same ids and meaning). Anything not listed is
-- unmatched, and unmatched means deny_and_log.
INSERT INTO action_classes(id,description,irreversible) VALUES
 ('read_research','Read and research; no state change',0),
 ('code_write_sandbox','Write code or files inside a disposable worktree/sandbox',0),
 ('merge_main','Merge a PR into the protected default branch (inherits deploy tier when merge auto-deploys)',0),
 ('deploy_production','Deploy an artifact to an environment (Core never deploys)',0),
 ('prod_db_migration','Run a database migration (Core never runs one)',1),
 ('outbound_email_external','Send email to new or external recipients (Core never sends)',1),
 ('spend_money','Spend real money (Core never does)',1),
 ('security_remediation','Fix a security finding by PR (merge is a separate merge_main action)',0),
 ('publish_external','Publish docs, changelog or announcements externally (Core never publishes)',1),
 ('config_secrets_iam_dns_billing','Secrets, IAM, DNS or billing configuration',1),
 ('policy_or_gate_change','Change gates, permissions, budgets, evaluators or the promotion pipeline (Tier 0; the Owner only)',1);

-- State machines copied verbatim from the full schema seed (ledger_row, work_order, run, approval, grant).
INSERT INTO legal_transitions(machine,from_state,to_state,guard) VALUES
 ('ledger_row','open','ready','Premise re-tested and still true; probe present and approved; dependencies done; acceptance clear'),
 ('ledger_row','open','parked','Owner or Program Lead parks with reason'),
 ('ledger_row','open','blocked','Blocker recorded'),
 ('ledger_row','ready','claimed','Work order issued; dedupe against open PRs and recent merges passed; WIP limit not exceeded; budget admits'),
 ('ledger_row','ready','parked','Owner or Program Lead parks with reason'),
 ('ledger_row','ready','blocked','Blocker recorded'),
 ('ledger_row','ready','open','Premise re-test failed or row needs re-scoping'),
 ('ledger_row','claimed','running','Run started under a live lease'),
 ('ledger_row','claimed','ready','Lease expired or work order cancelled before any run started'),
 ('ledger_row','claimed','blocked','Blocker recorded'),
 ('ledger_row','running','verifying','Run succeeded with a kernel-verified artifact'),
 ('ledger_row','running','ready','Run failed and attempts remain; cool-down elapsed'),
 ('ledger_row','running','blocked','Escalation raised and unanswered, or attempts exhausted'),
 ('ledger_row','running','parked','Owner parks'),
 ('ledger_row','verifying','awaiting_approval','Verifier concurrence, diff-policy pass, evidence bundle with no red scan; action tier >= L3'),
 ('ledger_row','verifying','merging','Action tier <= L2 or L4 auto-path; verifier concurrence; diff-policy pass; evidence bundle attached'),
 ('ledger_row','verifying','running','Verifier requested one revision (max 1 per escalation rule)'),
 ('ledger_row','verifying','blocked','Verifier disagreement persists after one revision'),
 ('ledger_row','verifying','done','Non-merge artifact (report, sent message id) verified by kernel and probe passes; evidence attached'),
 ('ledger_row','awaiting_approval','merging','Approval approved, hash and head SHA match, merge slot granted'),
 ('ledger_row','awaiting_approval','running','Approver requested changes'),
 ('ledger_row','awaiting_approval','ready','Approval denied or expired (default deny)'),
 ('ledger_row','awaiting_approval','parked','Owner parks'),
 ('ledger_row','merging','watching','Merged commit SHA recorded; CI green on merge-queue branch; probe passes on merged artifact'),
 ('ledger_row','merging','running','One bounded rebase attempt by owning agent after conflict'),
 ('ledger_row','merging','blocked','Second conflict or slot void'),
 ('ledger_row','watching','done','Watch window (24-72h) elapsed clean; probe still passing; docs/changelog fragment present if behavior changed'),
 ('ledger_row','watching','regressed','Probe fails or revert detected inside the window'),
 ('ledger_row','done','regressed','Probe later fails or a revert lands'),
 ('ledger_row','regressed','ready','Re-test confirms regression; new work order permitted'),
 ('ledger_row','regressed','open','Needs re-triage'),
 ('ledger_row','regressed','parked','Owner parks'),
 ('ledger_row','blocked','ready','Blocker cleared'),
 ('ledger_row','blocked','open','Re-scope'),
 ('ledger_row','blocked','parked','Owner parks'),
 ('ledger_row','parked','open','Owner or Program Lead unparks'),
 ('ledger_row','parked','ready','Owner or Program Lead unparks a fully specified row'),
 ('work_order','draft','issued','Schema-valid; touches/forbidden non-empty; acceptance[] all have probe_command; budget within stream envelope; tier <= stream cap'),
 ('work_order','draft','cancelled','Author or Program Lead cancels'),
 ('work_order','issued','running','First run started under lease'),
 ('work_order','issued','expired','TTL elapsed with no run started'),
 ('work_order','issued','cancelled','Program Lead, Chief of Staff or Owner cancels'),
 ('work_order','issued','superseded','A new version issued for the same ledger row'),
 ('work_order','running','completed','Latest run succeeded and artifact verified'),
 ('work_order','running','failed','Attempts exhausted or budget hard stop'),
 ('work_order','running','expired','TTL elapsed'),
 ('work_order','running','cancelled','Cancelled; active run killed first'),
 ('work_order','running','issued','Run failed, retry allowed: order returns to issued'),
 ('work_order','failed','superseded','Replaced by a re-scoped order'),
 ('run','queued','starting','Budget admits; policy and Rule-of-Two check pass; lease acquired; credentials minted'),
 ('run','queued','cancelled','Cancelled or dispatch refused'),
 ('run','starting','running','Adapter process live and session_id recorded'),
 ('run','starting','failed','Adapter failed to start'),
 ('run','starting','cancelled','Cancelled'),
 ('run','running','paused','Waiting on approval, decision card or escalation answer'),
 ('run','running','validating','Adapter exited and result JSON received'),
 ('run','running','failed','Nonzero exit or missing structured output'),
 ('run','running','timed_out','Turn or wall-clock cap exceeded'),
 ('run','running','killed','Kill switch, circuit breaker or budget hard stop'),
 ('run','running','cancelled','Cancelled by Owner, Chief of Staff or Program Lead'),
 ('run','paused','running','Answer or approval arrived before deadline; lease still valid'),
 ('run','paused','timed_out','Pause deadline reached'),
 ('run','paused','cancelled','Cancelled'),
 ('run','paused','killed','Kill switch or breaker'),
 ('run','validating','succeeded','Result schema-valid; at least one artifact verified by the kernel; claims cross-checked with trace'),
 ('run','validating','failed','Schema-invalid, artifact missing, or claim/trace mismatch'),
 ('approval','pending','approved','Owner responds approved; payload_hash and head_sha equal the request; challenge answered if required; step-up proof valid; approver is not the requester'),
 ('approval','pending','denied','Owner denies'),
 ('approval','pending','expired','expires_at reached (default deny)'),
 ('approval','pending','superseded','Payload or head SHA changed; new request minted'),
 ('approval','pending','revoked','Requester or kernel withdraws'),
 ('approval','approved','consumed','Gate action executed exactly once against the bound hash'),
 ('approval','approved','expired','Approval window elapsed unused'),
 ('approval','approved','superseded','Payload or head SHA changed before consumption'),
 ('approval','approved','revoked','Owner or kill switch revokes before consumption'),
 ('grant','pending','active','Merge slot: head of queue, no conflict with new tip, approval approved and unconsumed. Other kinds: approval present for tier >= L3'),
 ('grant','pending','expired','expires_at reached while queued'),
 ('grant','pending','revoked','Withdrawn'),
 ('grant','pending','void','Head SHA changed while queued'),
 ('grant','active','consumed','Single-use action executed (merge landed, migration applied, deploy done)'),
 ('grant','active','expired','expires_at reached'),
 ('grant','active','revoked','Owner, breaker or kill switch revokes'),
 ('grant','active','void','Observed head SHA differs from approved_head_sha, or base moved past allowed drift');


-- Core subset of the closed event union: 88 of the full plan's event types (158 when Core was cut), 25 of its 43 prefixes.
INSERT INTO event_types(type,producer,payload_summary,consumers,idempotency_key_rule) VALUES
 ('system.started','Kernel','kernel_version, schema_version, host_id, genesis(bool)','AuditLog, Watchdog','host_id+boot_id'),
 ('system.stopped','Kernel','reason, clean(bool)','Watchdog, Notifier','host_id+boot_id+''stop'''),
 ('system.kill_switch_engaged','KillSwitch','engaged_by(owner id), channel, credentials_revoked(int), runs_halted(int)','Supervisor, CredentialBroker, Notifier, AuditLog','kill_switch_id'),
 ('system.kill_switch_released','KillSwitch','released_by, step_up_method, agents_to_reinstate[]','Supervisor, Notifier, AuditLog','kill_switch_id+''release'''),
 ('system.config_changed','Settings','key, old_hash, new_hash, trust_tier, changed_by, approval_id','AuditLog, PolicyEngine','key+new_hash'),
 ('system.health_degraded','Watchdog','component, signal, observed, threshold','Notifier, ChiefOfStaff','component+signal+window_start'),
 ('system.backup_completed','Kernel','backup_ref, db_hash, bytes','Watchdog','backup_ref'),
 ('audit.chain_verification_failed','Auditor','chain(events|audit), first_bad_seq, expected_hash, found_hash','KillSwitch, Notifier','chain+first_bad_seq'),
 ('audit.finding_raised','Auditor','finding_id, check, severity, source(auditor|watchdog), affected{agent_id,run_id,project_id,grant_id}, breaker_requested(bool), evidence_refs[]','ChiefOfStaff, Notifier, AgentTier','finding_id'),
 ('project.created','API','project_id, slug, repo_url, wip_limit','Scheduler, ChiefOfStaff','project_id'),
 ('project.updated','API','project_id, changed_fields[], changed_by','Scheduler','project_id+version'),
 ('project.paused','API','project_id, reason, by','Scheduler, Supervisor','project_id+''pause''+version'),
 ('stream.created','API','stream_id, template, definition_hash','Scheduler','stream_id'),
 ('stream.updated','API','stream_id, version, definition_hash, changed_by','Scheduler, PolicyEngine','stream_id+version'),
 ('stream.fired','Scheduler','stream_id, trigger(cron|webhook|manual|reconciler|event), trigger_ref, fire_id','ProgramLead, Ledger','fire_id (cron: stream_id+scheduled_for; webhook: delivery id)'),
 ('stream.paused','API','stream_id, by, reason','Scheduler','stream_id+''pause''+version'),
 ('stream.resumed','API','stream_id, by','Scheduler','stream_id+''resume''+version'),
 ('reconciler.completed','Reconciler','scope, items_checked, drift_count, duration_ms','Watchdog','scope+run_started_at'),
 ('reconciler.drift_detected','Reconciler','kind(missed_webhook|orphan_pr|orphan_branch|ledger_mismatch|stale_lease), external_ref, ledger_row_id','ChiefOfStaff, Ledger','kind+external_ref+observed_state_hash'),
 ('ledger.row_created','Ledger','ledger_row_id, project_id, priority, lane, probe_hash, created_by','ProgramLead','ledger_row_id'),
 ('ledger.row_status_changed','Ledger','ledger_row_id, from, to, guard_evidence, actor','ProgramLead, Notifier, Retro','ledger_row_id+to+transition_seq'),
 ('ledger.row_premise_retested','Ledger','ledger_row_id, still_valid(bool), method, evidence_ref','ProgramLead','ledger_row_id+retest_nonce'),
 ('ledger.probe_executed','ProbeRunner','ledger_row_id, probe_revision, target_kind(branch|merged|deployed), target_sha, status, result_id','Ledger, Verifier','result_id'),
 ('ledger.row_regressed','Ledger','ledger_row_id, previous_status, failing_result_id, suspected_sha','ProgramLead, ErrorBudget, Notifier','ledger_row_id+failing_result_id'),
 ('work_order.drafted','ProgramLead','work_order_id, ledger_row_id, version, content_hash','Verifier, Scheduler','work_order_id+version'),
 ('work_order.issued','ProgramLead','work_order_id, content_hash, doer_agent_id, autonomy_tier, expires_at','Supervisor, LeaseManager','work_order_id+content_hash'),
 ('work_order.superseded','ProgramLead','work_order_id, superseded_by','Supervisor','work_order_id+superseded_by'),
 ('work_order.expired','Scheduler','work_order_id, ttl_s','ProgramLead, Ledger','work_order_id+''expired'''),
 ('work_order.cancelled','API','work_order_id, by, reason','Supervisor, LeaseManager','work_order_id+''cancelled'''),
 ('work_order.completed','Supervisor','work_order_id, final_run_id','Ledger, Verifier','work_order_id+final_run_id'),
 ('work_order.failed','Supervisor','work_order_id, attempts, failure_class','ProgramLead, Retro','work_order_id+attempts'),
 ('dispatch.refused_budget','BudgetGovernor','work_order_id, budget_id, would_exceed(kind), remaining','ProgramLead, Notifier','work_order_id+budget_id+window'),
 ('dispatch.refused_policy','PolicyEngine','work_order_id, rule_id, rule_version, reason','ProgramLead','work_order_id+rule_id+attempt'),
 ('dispatch.deduped','Scheduler','work_order_id, duplicate_of(pr|work_order|merge), ref','ProgramLead','work_order_id+ref'),
 ('run.queued','Supervisor','run_id, work_order_id, agent_id, vendor, attempt','LeaseManager, BudgetGovernor','run_id'),
 ('run.started','Supervisor','run_id, session_id, adapter_version, lease_id, workspace_path, input_hash','Deck, Watchdog','run_id+''started'''),
 ('run.paused','Supervisor','run_id, waiting_on(approval|decision_card|escalation), ref, deadline','Deck','run_id+ref'),
 ('run.resumed','Supervisor','run_id, answer_ref','Deck','run_id+ref+''resume'''),
 ('run.result_submitted','Adapter','run_id, result_hash, status, exit_code','Supervisor','run_id+result_hash'),
 ('run.artifact_verified','Supervisor','run_id, artifact_kind, ref, sha, verified_by(kernel)','Ledger, Verifier','run_id+ref+sha'),
 ('run.succeeded','Supervisor','run_id, artifact_count, cost_usd','Ledger, Verifier, BudgetGovernor','run_id+''succeeded'''),
 ('run.failed','Supervisor','run_id, failure_class(adapter|schema|no_artifact|claim_mismatch|nonzero_exit), detail','Ledger, Retro, ProgramLead','run_id+''failed'''),
 ('run.timed_out','Supervisor','run_id, cap(turns|wall_clock|pause)','Ledger, ProgramLead','run_id+''timed_out'''),
 ('run.cancelled','Supervisor','run_id, by, reason','Ledger','run_id+''cancelled'''),
 ('run.killed','Supervisor','run_id, cause(kill_switch|breaker|budget_hard_stop|quarantine)','Ledger, Notifier','run_id+''killed'''),
 ('run.claim_mismatch','Auditor','run_id, claim, expected_tool_call, found(bool)','AgentTier, Retro, Notifier','run_id+claim_hash'),
 ('lease.acquired','LeaseManager','lease_id, resource_kind, resource_key, holder_agent_id, expires_at, fence_token','Supervisor','lease_id'),
 ('lease.released','LeaseManager','lease_id, reason','Scheduler','lease_id+''released'''),
 ('lease.expired','LeaseManager','lease_id, last_heartbeat_at','Supervisor, Ledger','lease_id+''expired'''),
 ('grant.consumed','CredentialBroker','grant_id, action_ref, result_sha','Ledger, AuditLog','grant_id+''consumed'''),
 ('grant.revoked','CredentialBroker','grant_id, by, reason','Supervisor, AuditLog','grant_id+''revoked'''),
 ('merge_slot.requested','MergeCoordinator','grant_id, pr_url, head_sha, queue_position','Deck','grant_id+''requested'''),
 ('merge_slot.granted','MergeCoordinator','grant_id, pr_url, approved_head_sha, base_sha, expires_at, conflict_check','Supervisor, AuditLog','grant_id+''granted'''),
 ('merge_slot.void','MergeCoordinator','grant_id, reason(head_sha_changed|base_moved|expired), observed_head_sha','Ledger, ProgramLead, Notifier','grant_id+''void'''),
 ('merge_slot.landed','MergeCoordinator','grant_id, merged_sha, queue_branch_ci(green), pr_url','Ledger, Verifier, Watchdog','grant_id+merged_sha'),
 ('approval.requested','ApprovalService','approval_id, action_class, environment, tier, payload_hash, head_sha, evidence_bundle_id, expires_at, challenge_required','Deck, Notifier','approval_id'),
 ('approval.responded','ApprovalService','approval_id, decision, approver_id, method, payload_hash_match(bool), latency_s','Ledger, GrantIssuer, AgentTier','approval_id+''responded'''),
 ('approval.consumed','ApprovalService','approval_id, action_ref','Ledger, AuditLog','approval_id+''consumed'''),
 ('approval.expired','ApprovalService','approval_id, default_applied(deny)','Ledger, AgentTier, Notifier','approval_id+''expired'''),
 ('approval.revoked','ApprovalService','approval_id, by, reason','Ledger','approval_id+''revoked'''),
 ('approval.rejected_hash_mismatch','ApprovalService','approval_id, expected_hash, got_hash','Auditor','approval_id+got_hash'),
 ('evidence.bundle_created','EvidenceService','bundle_id, subject_kind, subject_ref, bundle_hash, scan_red(bool)','ApprovalService, Verifier','bundle_id'),
 ('evidence.scan_red_blocked','EvidenceService','bundle_id, failing_checks[]','ProgramLead, Ledger','bundle_id+''red'''),
 ('verification.report_submitted','Verifier','report_id, work_order_id, run_id, head_sha, verdict(pass|fail|needs_human|void), void_reason, finding_counts{critical,high,medium,low}, context_leak(bool), advisory(true)','ProgramLead, ChiefOfStaff, EvidenceService','report_id'),
 ('decision_card.created','ChiefOfStaff','card_id, variant, urgency, deadline_at, default_on_timeout, source','Deck, Notifier','card_id'),
 ('decision_card.answered','API','card_id, variant, answer, answered_by, via_approval_id','Supervisor, Ledger','card_id+''answered'''),
 ('decision_card.expired','Scheduler','card_id, default_applied','Supervisor, Ledger','card_id+''expired'''),
 ('decision_card.withdrawn','ChiefOfStaff','card_id, reason','Deck','card_id+''withdrawn'''),
 ('budget.set','API','budget_id, scope, caps, set_by(owner), prior_hash','AuditLog, BudgetGovernor','budget_id+version'),
 ('budget.threshold_crossed','BudgetGovernor','budget_id, pct, burn_pct, acceptance_met_pct','ProgramLead, Notifier','budget_id+pct+window'),
 ('budget.hard_stop','BudgetGovernor','budget_id, runs_killed[]','Supervisor, Notifier','budget_id+window'),
 ('breaker.tripped','BudgetGovernor','scope, signal(error_rate|denials|volume|egress|loop|cost_velocity), observed, threshold, action(demote|suspend|pause)','AgentTier, Supervisor, Notifier','scope+signal+window_start'),
 ('breaker.reset','API','scope, by, step_up_method','AgentTier, Scheduler','scope+''reset''+tripped_event_id'),
 ('agent.registered','API','agent_id, role, vendor, model, tool_manifest_hash, rule_of_two_flags','PolicyEngine','agent_id'),
 ('agent.suspended','API','agent_id, cause, credentials_revoked','Supervisor','agent_id+cause+ts_bucket'),
 ('agent.quarantined','Auditor','agent_id, finding_ref','Supervisor','agent_id+finding_ref'),
 ('watch.started','Ledger','ledger_row_id, merged_sha, window_hours, until','Watchdog','ledger_row_id+merged_sha'),
 ('watch.window_closed_clean','Watchdog','ledger_row_id, merged_sha, probe_result_id','Ledger, AgentTier','ledger_row_id+merged_sha+''clean'''),
 ('watch.regression_detected','Watchdog','ledger_row_id, signal(probe|revert|incident), ref','Ledger, ErrorBudget, AgentTier','ledger_row_id+signal+ref'),
 ('policy.rule_changed','API','rule_id, from_version, to_version, rule_hash, changed_by[2 humans if loop thresholds]','PolicyEngine, AuditLog','rule_id+to_version'),
 ('policy.tamper_tripwire_fired','PolicyEngine','run_id, work_order_id, paths[], pattern, action(block|escalate)','Auditor, AgentTier, Notifier','work_order_id+diff_hash+pattern'),
 ('policy.diff_policy_failed','PolicyEngine','work_order_id, violations[], diff_hash','ProgramLead, Verifier','work_order_id+diff_hash'),
 ('status_report.published','ProgramLead','report_id, project_id, kind, period, data_as_of','ChiefOfStaff','report_id'),
 ('digest.published','Kernel','digest_id, kind(daily|audit_weekly|health_daily), figure_count, stale_count, failed_count, recompute_matched(true), data_as_of','ChiefOfStaff, Deck','digest_id'),
 ('digest.rejected','Kernel','digest_id, kind, reason(mismatch|missing_query_id|unlabelled_stale), mismatches[]','ProgramLead, Watchdog','digest_id+''rejected'''),
 ('notification.queued','Notifier','notification_id, channel, kind, priority, dedupe_key','Deck','dedupe_key'),
 ('notification.delivered','Notifier','notification_id, channel, delivered_at','Deck','notification_id+''delivered'''),
 ('watchdog.alert_raised','Watchdog','alert_id, detector, severity(info|warn|page), subject_kind, subject_id, observed{value,unit,window,query_id}, threshold, suggested_action(stop_run|request_breaker|open_row|human|none), supersedes','ChiefOfStaff, Notifier, Auditor','detector+subject_id+window_start');


-- Core settings. Tier 0 rows can be written only with updated_by = an Owner id.
INSERT INTO settings(key,value,trust_tier,description,updated_by) VALUES
 ('owner',               '{"id":"own_local","display_name":"Owner"}', 0, 'The single Owner principal. Agents are never own_*.', 'own_local'),
 ('autonomy.max_global_tier', '"L3"', 0, 'Global ceiling. Core never exceeds L3.', 'own_local'),
 ('approvals.default_ttl_minutes', '240', 0, 'Approval lifetime; default on timeout is deny.', 'own_local'),
 ('merge_slot.ttl_minutes', '30', 0, 'Merge slot lifetime.', 'own_local'),
 ('leases.ttl_minutes', '20', 0, 'Lease lifetime; heartbeat every 60 s.', 'own_local'),
 ('kill_switch',         '{"engaged":false}', 1, 'Engage: Owner or system. Release: Owner only.', 'system'),
 ('ui.calm_mode',        'false', 2, 'Calm mode mutes every reward to a single tick.', 'own_local'),
 ('ui.rewards_enabled',  'true', 2, 'Master switch for table-cleared and cargo-landed.', 'own_local'),
 ('relay.stage',         '"R2"', 1, 'R0/R1 for vendors that cannot be driven headlessly; R2 supervised headless.', 'own_local'),
 ('digest.narrative',    'false', 1, 'Let the Chief of Staff write the headline paragraph (each claim must cite a query id).', 'own_local');

-- ============================================================================
-- OMITTED (present in 03-contracts/schema.sql, deliberately absent from Core)
--   tables   : trust_tiers, tier_defaults, tier_assignments, tier_changes (autonomy is a policy file in Core)
--              owners (settings('owner')), ledger_probe_revisions (probes immutable), probe_results (events + bundle),
--              tool_calls (no MCP proxy), escalations (decision cards), audit_records/audit_anchors (single chain),
--              retro_findings, lessons, skills, eval_suites, proposals, eval_runs, memory_entries, notifications,
--              verifier_reports, audit_findings, watchdog_alerts, stop_signals, handoff_notes, ledger_row_proposals,
--              draft_artifacts, digest_reports, postmortems, incidents, incident_timelines, diagnosis_reports,
--              retro_reports, skill_candidates, skill_verifications, briefs
--   columns  : ledger_rows.last_probe_result_id
--   triggers : every trigger on the omitted tables; trg_ledger_probe_immutable is the stricter Core twin of the
--              full revision-aware trigger
-- ============================================================================
