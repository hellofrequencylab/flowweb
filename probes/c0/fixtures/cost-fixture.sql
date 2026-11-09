-- Fixture for c0/cost-record, not a row probe. Inserted directly (as a test harness would) into a
-- database the store created, so the CLI's spend rollup can be compared with plain SQL sums.
-- Three runs by two agents: run_fx000001 and run_fx000002 have spend entries, run_fx000003 has none.
INSERT INTO projects(id, slug, name) VALUES ('prj_fx000001', 'probe-fixture', 'Probe fixture');
INSERT INTO streams(id, project_id, key, name, template, definition, definition_hash, status)
  VALUES ('stm_fx000001', 'prj_fx000001', 'backlog', 'Backlog', 'backlog_dev', '{}', printf('%064d', 1), 'active');
INSERT INTO agents(id, name, role, vendor, model, tier) VALUES
  ('agt_fxwork01', 'fixture worker one', 'worker', 'local', 'fake', 'L2'),
  ('agt_fxwork02', 'fixture worker two', 'worker', 'local', 'fake', 'L2'),
  ('agt_fxveri01', 'fixture verifier', 'verifier', 'local', 'fake', 'L1');
INSERT INTO ledger_rows(id, project_id, stream_id, title, priority, lane, size, owner_kind, owner_id,
  probe_kind, probe_spec, probe_expected, probe_measures, probe_hash)
  VALUES ('lr_fx000001', 'prj_fx000001', 'stm_fx000001', 'Fixture row', 'P1', 'kernel', 'S', 'owner', 'own_local',
  'command', '{"argv":["true"],"timeout_s":10}', '{"exit_code":0}', 'Fixture probe measures nothing real', printf('%064d', 2));
INSERT INTO work_orders(id, project_id, stream_id, ledger_row_id, title, body, content_hash, autonomy_tier,
  doer_agent_id, verifier_agent_id, status, issued_at, expires_at) VALUES
  ('wo_fx000001', 'prj_fx000001', 'stm_fx000001', 'lr_fx000001', 'Fixture order', '{}', printf('%064d', 3), 'L2',
   'agt_fxwork01', 'agt_fxveri01', 'issued', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'));
INSERT INTO work_orders(id, project_id, stream_id, ledger_row_id, version, title, body, content_hash, autonomy_tier,
  doer_agent_id, verifier_agent_id, status, issued_at, expires_at) VALUES
  ('wo_fx000002', 'prj_fx000001', 'stm_fx000001', 'lr_fx000001', 2, 'Fixture order two', '{}', printf('%064d', 4), 'L2',
   'agt_fxwork02', 'agt_fxveri01', 'issued', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'));
INSERT INTO runs(id, work_order_id, project_id, stream_id, agent_id, attempt, adapter_name, adapter_vendor) VALUES
  ('run_fx000001', 'wo_fx000001', 'prj_fx000001', 'stm_fx000001', 'agt_fxwork01', 1, 'fake', 'local'),
  ('run_fx000002', 'wo_fx000002', 'prj_fx000001', 'stm_fx000001', 'agt_fxwork02', 1, 'fake', 'local'),
  ('run_fx000003', 'wo_fx000001', 'prj_fx000001', 'stm_fx000001', 'agt_fxwork01', 2, 'fake', 'local');
INSERT INTO spend_entries(id, project_id, stream_id, run_id, agent_id, kind, vendor, model, tokens_in, tokens_out, usd, idempotency_key) VALUES
  ('spd_fx000001', 'prj_fx000001', 'stm_fx000001', 'run_fx000001', 'agt_fxwork01', 'model_tokens', 'local', 'fake', 1000, 200, 0.125, 'fx-1'),
  ('spd_fx000002', 'prj_fx000001', 'stm_fx000001', 'run_fx000001', 'agt_fxwork01', 'model_tokens', 'local', 'fake', 500, 100, 0.0625, 'fx-2'),
  ('spd_fx000003', 'prj_fx000001', 'stm_fx000001', 'run_fx000002', 'agt_fxwork02', 'model_tokens', 'local', 'fake', 3000, 900, 0.5, 'fx-3');
