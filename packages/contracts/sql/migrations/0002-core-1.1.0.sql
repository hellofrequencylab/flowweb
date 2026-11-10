-- Migration 0002: schema 1.0.0-core -> 1.1.0-core (forward only).
--
-- 1. runs.failure_class gains 'policy' (a run whose change broke the diff policy).
--    SQLite cannot alter a CHECK, so runs is rebuilt the documented way: create runs_new with the
--    new definition, copy every row, drop runs, rename runs_new to runs, then recreate the indexes
--    and the triggers that lived on runs (dropping a table drops its indexes and triggers).
-- 2. trg_events_no_secret_shapes also refuses a bare PKCS#8 header ("BEGIN PRIVATE KEY").
-- 3. schema_meta.schema_version = '1.1.0-core'.
--
-- The runner (@fw/eventlog openStore) applies this file inside ONE transaction (BEGIN IMMEDIATE
-- ... COMMIT), with PRAGMA foreign_keys=OFF and PRAGMA legacy_alter_table=ON set on the connection
-- beforehand (neither can change inside a transaction): foreign keys off so dropping runs leaves
-- the rows that reference it alone, legacy rename so the rename leaves the triggers and views of
-- other tables that name runs as they are. Before COMMIT it runs PRAGMA foreign_key_check (must be
-- empty), checks schema_version, and records migration_0002_sha256 (this file) in schema_meta; any
-- error rolls everything back. The definitions below are copied from schema.core.sql 1.1.0-core; a
-- test checks that an upgraded database has exactly the tables, indexes, triggers and views of a
-- fresh 1.1.0-core one.

CREATE TABLE runs_new (
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
INSERT INTO runs_new SELECT * FROM runs;  -- same columns in the same order
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX idx_runs_status ON runs(status, project_id);
CREATE INDEX idx_runs_agent ON runs(agent_id, started_at);
CREATE INDEX idx_runs_wo ON runs(work_order_id);

CREATE TRIGGER trg_runs_transition BEFORE UPDATE OF status ON runs
WHEN OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'illegal run transition')
    WHERE NOT EXISTS (SELECT 1 FROM legal_transitions WHERE machine = 'run' AND from_state = OLD.status AND to_state = NEW.status);
END;

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

CREATE TRIGGER trg_runs_succeeded_requires_artifact BEFORE UPDATE OF status ON runs
WHEN NEW.status = 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'runs: succeeded requires >=1 kernel-verified artifact (an agent saying "completed" is not evidence)')
    WHERE NOT EXISTS (SELECT 1 FROM run_artifacts a WHERE a.run_id = NEW.id AND a.verified_by_kernel = 1);
  SELECT RAISE(ABORT, 'runs: succeeded requires result_hash and exit_code=0')
    WHERE NEW.result_hash IS NULL OR NEW.exit_code IS NOT 0;
END;

DROP TRIGGER trg_events_no_secret_shapes;
CREATE TRIGGER trg_events_no_secret_shapes BEFORE INSERT ON events
WHEN NEW.payload GLOB '*sk-ant-*' OR NEW.payload GLOB '*sk-proj-*' OR NEW.payload GLOB '*ghp_[A-Za-z0-9]*'
  OR NEW.payload GLOB '*github_pat_*' OR NEW.payload GLOB '*AKIA[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]*'
  OR NEW.payload GLOB '*xox[bp]-*' OR NEW.payload GLOB '*BEGIN *PRIVATE KEY*'
BEGIN SELECT RAISE(ABORT, 'events: payload contains a secret-shaped token; redact before write'); END;

UPDATE schema_meta SET value = '1.1.0-core' WHERE key = 'schema_version';
