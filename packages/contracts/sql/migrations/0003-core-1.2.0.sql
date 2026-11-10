-- Migration 0003: schema 1.1.0-core -> 1.2.0-core (forward only).
--
-- A ledger row built outside fwd (by hand, or by an agent working in its own checkout) never
-- passes through claimed, running and verifying, so `fw ledger close` had no legal step to done
-- for it. Two transitions are added. Neither weakens the definition of done: the move is still
-- refused by trg_ledger_done_requires_proof unless the row's probe passed and a green,
-- kernel-captured evidence bundle bound to the merged SHA is attached.
--   open   -> done   built outside fwd and merged
--   parked -> done   parked by `fw ledger retest` because its probe already passed, then closed
--
-- Data only: no table, index, trigger or view changes. Applied by @fw/eventlog openStore in one
-- transaction, which records migration_0003_sha256 (this file) in schema_meta.

INSERT INTO legal_transitions(machine,from_state,to_state,guard) VALUES
 ('ledger_row','open','done','Built outside fwd (by hand or another tool) and merged: probe passes on the merged commit; kernel-captured evidence attached'),
 ('ledger_row','parked','done','Parked because its probe already passed, then closed: probe passes on the merged commit; kernel-captured evidence attached');

UPDATE schema_meta SET value = '1.2.0-core' WHERE key = 'schema_version';
