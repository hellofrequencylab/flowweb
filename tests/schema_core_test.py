#!/usr/bin/env python3
"""Behaviour tests for core/schema.core.sql (SQLite triggers and constraints).

Run from anywhere:   python3 -I core/tests/schema_core_test.py -v
No third-party packages. Needs SQLite >= 3.38 (json functions).

These tests ARE the executable spec for the Core safety properties:
  append-only + hash-chained event log, single writer per artifact (leases), hash-bound approvals,
  merge slot voiding on head SHA change, budget hard stops, kill switch, "done means proven",
  maker != checker, Owner-only Tier 0 writes, and "Core is a strict subset of the full schema".
"""
import hashlib
import json
import pathlib
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
CORE_SQL = (HERE.parent / "schema.core.sql").read_text()
FULL_SQL_PATH = HERE.parent.parent / "03-contracts" / "schema.sql"   # optional: only for the subset test
ZERO = "0" * 64
SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40
SHA_BASE = "d" * 40
OWNER = "own_local"


def iso(delta_s=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_s)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def canonical(o):
    # Stand-in for RFC 8785 JCS (sufficient for ASCII test payloads): sorted keys, no whitespace.
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def append_event(db, type_, payload=None, key=None, actor=("system", "fwd"), **scope):
    """Reference implementation of the single-writer event append (what @fw/eventlog does)."""
    payload = payload or {}
    head = db.execute("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").fetchone()
    seq = (head[0] if head else 0) + 1
    prev = head[1] if head else ZERO
    env = {
        "seq": seq, "id": "evt_%026d" % seq, "ts": iso(), "type": type_, "version": 1,
        "actor": {"kind": actor[0], "id": actor[1]},
        "project_id": scope.get("project_id"), "stream_id": scope.get("stream_id"),
        "work_order_id": scope.get("work_order_id"), "run_id": scope.get("run_id"),
        "correlation_id": scope.get("correlation_id", "corr_1"), "causation_id": None,
        "idempotency_key": key or ("k%d" % seq), "payload": payload,
        "payload_hash": sha(canonical(payload)), "prev_hash": prev,
    }
    env["hash"] = sha(prev + "\n" + canonical({k: v for k, v in env.items() if k != "hash"}))
    db.execute(
        "INSERT INTO events(seq,id,ts,type,version,actor_kind,actor_id,project_id,stream_id,work_order_id,run_id,"
        "correlation_id,causation_id,idempotency_key,payload,payload_hash,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (env["seq"], env["id"], env["ts"], env["type"], 1, actor[0], actor[1], env["project_id"], env["stream_id"],
         env["work_order_id"], env["run_id"], env["correlation_id"], None, env["idempotency_key"],
         canonical(payload), env["payload_hash"], prev, env["hash"]))
    return env


def verify_chain(db):
    """Reference implementation of `fw audit verify`: returns (ok, first_bad_seq)."""
    prev = ZERO
    for row in db.execute("SELECT seq,id,ts,type,version,actor_kind,actor_id,project_id,stream_id,work_order_id,run_id,"
                          "correlation_id,causation_id,idempotency_key,payload,payload_hash,prev_hash,hash FROM events ORDER BY seq"):
        (seq, id_, ts, type_, ver, ak, aid, pj, st, wo, run, corr, cau, idem, payload, ph, pv, hh) = row
        env = {"seq": seq, "id": id_, "ts": ts, "type": type_, "version": ver, "actor": {"kind": ak, "id": aid},
               "project_id": pj, "stream_id": st, "work_order_id": wo, "run_id": run, "correlation_id": corr,
               "causation_id": cau, "idempotency_key": idem, "payload": json.loads(payload),
               "payload_hash": ph, "prev_hash": pv}
        if pv != prev or ph != sha(canonical(json.loads(payload))) or hh != sha(pv + "\n" + canonical(env)):
            return False, seq
        prev = hh
    return True, None


class CoreDB(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", isolation_level=None)   # autocommit; each statement is its own tx
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(CORE_SQL)
        self.db.execute("PRAGMA foreign_keys=ON")

    def tearDown(self):
        self.db.close()

    # ---- helpers ---------------------------------------------------------------------------------
    def x(self, sql, *args):
        return self.db.execute(sql, args)

    def one(self, sql, *args):
        r = self.db.execute(sql, args).fetchone()
        return r[0] if r else None

    def fails(self, regex, sql, *args):
        with self.assertRaisesRegex(sqlite3.DatabaseError, regex):
            self.db.execute(sql, args)

    # ---- fixtures --------------------------------------------------------------------------------
    def agent(self, aid, role, vendor="anthropic", tier="L2", status="active"):
        self.x("INSERT INTO agents(id,name,role,vendor,model,tier,status) VALUES (?,?,?,?,?,?,?)",
               aid, aid, role, vendor, "model-x", tier, status)

    def base(self):
        """Project, stream, worker (doer), verifier (different vendor), chief, one claimed row."""
        self.x("INSERT INTO projects(id,slug,name,repo_url) VALUES ('prj_core1','core1','Core One','file:///repo.git')")
        self.agent("agt_chief1", "chief_of_staff", tier="L1")
        self.agent("agt_work1", "worker", "anthropic", "L2")
        self.agent("agt_veri1", "verifier", "openai", "L1")
        self.x("INSERT INTO streams(id,project_id,key,name,template,definition,definition_hash,status) "
               "VALUES ('stm_dev1','prj_core1','dev','Dev from backlog','backlog_dev','{}',?, 'active')", sha("def"))

    def row(self, rid="lr_000001", status="claimed", **over):
        probe = canonical({"cmd": "pnpm probe kernel/x"})
        cols = dict(id=rid, project_id="prj_core1", stream_id="stm_dev1", title="A thing", priority="P1", lane="kernel",
                    size="S", status=status, owner_kind="agent", owner_id="agt_work1", probe_kind="command",
                    probe_spec=probe, probe_expected='{"exit_code":0}', probe_measures="The probe measures a real consequence",
                    probe_hash=sha(probe))
        cols.update(over)
        self.x("INSERT INTO ledger_rows(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), *cols.values())
        return rid

    def wo(self, wid="wo_000001", rid="lr_000001", issue=True, max_usd=1.5):
        body = canonical({"id": wid, "budget": {"caps": {"max_usd": max_usd}, "ttl_hours": 8}})
        self.x("INSERT INTO work_orders(id,project_id,stream_id,ledger_row_id,title,body,content_hash,autonomy_tier,"
               "doer_agent_id,verifier_agent_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
               wid, "prj_core1", "stm_dev1", rid, "Do the thing", body, sha(body), "L2", "agt_work1", "agt_veri1")
        if issue:
            self.x("UPDATE work_orders SET status='issued', issued_at=?, expires_at=? WHERE id=?", iso(), iso(3600), wid)
        return wid

    def lease(self, lid="lse_000001", key="wt:prj_core1:lr_000001", fence=1, agent="agt_work1", kind="worktree"):
        self.x("INSERT INTO leases(id,resource_kind,resource_key,holder_agent_id,fence_token,expires_at) VALUES (?,?,?,?,?,?)",
               lid, kind, key, agent, fence, iso(1200))
        return lid

    def mkrun(self, rid="run_000001", wid="wo_000001", agent="agt_work1", lease=None, attempt=1):
        self.x("INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,attempt,adapter_name,adapter_vendor,lease_id) "
               "VALUES (?,?,?,?,?,?,?,?,?)", rid, wid, "prj_core1", "stm_dev1", agent, attempt, "claude-cli", "anthropic", lease)
        return rid

    def running_run(self):
        self.base(); self.row(); self.wo(); le = self.lease(); r = self.mkrun(lease=le)
        self.x("UPDATE runs SET status='starting' WHERE id=?", r)
        self.x("UPDATE runs SET status='running', started_at=? WHERE id=?", iso(), r)
        return r

    def bundle(self, bid="evb_000001", sha_=SHA_A, red=0, reviewer="agt_veri1", verdict="concur", captured="ci_sandbox"):
        body = {"id": bid, "independent_check": {"reviewer_agent_id": reviewer, "vendor": "openai", "verdict": verdict, "advisory": True}}
        self.x("INSERT INTO evidence_bundles(id,subject_kind,subject_ref,subject_sha,body,bundle_hash,scan_red,captured_by) "
               "VALUES (?,?,?,?,?,?,?,?)", bid, "pull_request", "https://git.invalid/core1/pull/7", sha_, canonical(body), sha(bid), red, captured)
        return bid

    def approval(self, aid="apr_000001", head=SHA_A, bundle="evb_000001", ttl=3600, wid="wo_000001", **over):
        payload = sha("payload-" + aid)
        cols = dict(id=aid, action_class="merge_main", environment="production", tier="L3", subject_kind="pull_request",
                    subject_ref="https://git.invalid/core1/pull/7", payload_hash=payload, head_sha=head,
                    evidence_bundle_id=bundle, requester_agent_id="agt_chief1",
                    request=canonical({"id": aid, "work_order_id": wid}), expires_at=iso(ttl))
        cols.update(over)
        self.x("INSERT INTO approvals(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), *cols.values())
        return aid, cols["payload_hash"]

    def owner_approves(self, aid, payload_hash, method="deck_click", approver=OWNER, responded=None, resp_hash=None):
        self.x("UPDATE approvals SET status='approved', decision='approved', approver_id=?, method=?, responded_at=?, response_payload_hash=? WHERE id=?",
               approver, method, responded or iso(), resp_hash or payload_hash, aid)

    def slot(self, gid="grt_000001", aid="apr_000001", wid="wo_000001", head=SHA_A, pr=7, branch="main"):
        self.x("INSERT INTO grants(id,kind,project_id,work_order_id,resource_kind,resource_ref,approval_id,pr_repo,pr_number,base_branch,"
               "base_sha_at_grant,approved_head_sha,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
               gid, "merge_slot", "prj_core1", wid, "merge_slot", "merge-slot:core1:main", aid, "core1", pr, branch, SHA_BASE, head, iso(1800))
        return gid

    def approved_slot_world(self):
        """Everything up to an approved merge approval and a pending merge slot, row in 'verifying'."""
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval(); self.owner_approves(aid, ph)
        return aid, ph, self.slot()

    def advance(self, rid="lr_000001"):
        """claimed -> running -> verifying through the legal state machine (the run itself is out of scope here)."""
        self.x("UPDATE ledger_rows SET status='running' WHERE id=?", rid)
        self.x("UPDATE ledger_rows SET status='verifying' WHERE id=?", rid)

    def activate(self, gid="grt_000001"):
        self.x("UPDATE grants SET status='active', issued_at=? WHERE id=?", iso(), gid)

    # =========================== A. event log: append-only, hash chain =================================
    def test_01_events_append_and_chain_verifies(self):
        for i in range(5):
            append_event(self.db, "system.started", {"i": i})
        self.assertEqual(verify_chain(self.db), (True, None))
        self.assertEqual(self.one("SELECT COUNT(*) FROM events"), 5)

    def test_02_events_update_forbidden(self):
        append_event(self.db, "system.started")
        self.fails("append-only", "UPDATE events SET payload='{}' WHERE seq=1")

    def test_03_events_delete_forbidden(self):
        append_event(self.db, "system.started")
        self.fails("append-only", "DELETE FROM events WHERE seq=1")

    def test_04_events_seq_gap_rejected(self):
        append_event(self.db, "system.started")
        head = self.one("SELECT hash FROM events WHERE seq=1")
        self.fails("seq must be max", "INSERT INTO events(seq,id,ts,type,actor_kind,actor_id,correlation_id,idempotency_key,payload,payload_hash,prev_hash,hash) "
                   "VALUES (3,'evt_3',?,?,?,?,?,?,?,?,?,?)", iso(), "system.started", "system", "fwd", "c", "k3", "{}", ZERO, head, sha("x"))

    def test_05_events_wrong_prev_hash_rejected(self):
        append_event(self.db, "system.started")
        self.fails("prev_hash must equal head", "INSERT INTO events(seq,id,ts,type,actor_kind,actor_id,correlation_id,idempotency_key,payload,payload_hash,prev_hash,hash) "
                   "VALUES (2,'evt_2',?,?,?,?,?,?,?,?,?,?)", iso(), "system.started", "system", "fwd", "c", "k2", "{}", ZERO, ZERO, sha("y"))

    def test_06_events_unknown_type_rejected(self):
        with self.assertRaisesRegex(sqlite3.DatabaseError, "FOREIGN KEY"):
            append_event(self.db, "made.up_event")

    def test_07_events_idempotency_key_unique_per_type(self):
        append_event(self.db, "run.started", key="run_1+started")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "UNIQUE"):
            append_event(self.db, "run.started", key="run_1+started")
        append_event(self.db, "run.failed", key="run_1+started")   # same key, different type: fine
        self.assertEqual(self.one("SELECT COUNT(*) FROM events"), 2)

    def test_08_chain_verifier_detects_out_of_band_tamper(self):
        for i in range(4):
            append_event(self.db, "system.started", {"i": i})
        # Simulate an attacker with raw file access who drops the guard trigger and edits history.
        self.x("DROP TRIGGER trg_events_no_update")
        self.x("UPDATE events SET payload='{\"i\":99}' WHERE seq=2")
        ok, bad = verify_chain(self.db)
        self.assertFalse(ok)
        self.assertEqual(bad, 2)

    def test_09_events_secret_shaped_payload_rejected(self):
        for secret in ("sk-ant-api03-abcdef", "ghp_abcdefghij1234567890", "AKIAABCDEFGHIJKLMNOP", "-----BEGIN OPENSSH PRIVATE KEY-----"):
            with self.assertRaisesRegex(sqlite3.DatabaseError, "secret-shaped"):
                append_event(self.db, "system.config_changed", {"note": secret})
        append_event(self.db, "system.config_changed", {"note": "a normal sentence"})

    def test_10_other_append_only_tables(self):
        r = self.running_run()
        self.x("INSERT INTO run_steps(id,run_id,seq,kind,started_at) VALUES ('stp_1',?,0,'prompt',?)", r, iso())
        self.fails("append-only", "UPDATE run_steps SET kind='checkpoint' WHERE id='stp_1'")
        self.fails("append-only", "DELETE FROM run_steps WHERE id='stp_1'")
        self.x("INSERT INTO spend_entries(id,run_id,kind,usd,idempotency_key) VALUES ('spd_1',?,'model_tokens',0.01,'i1')", r)
        self.fails("append-only", "UPDATE spend_entries SET usd=0 WHERE id='spd_1'")
        self.fails("append-only", "DELETE FROM spend_entries WHERE id='spd_1'")
        self.bundle()
        self.fails("append-only", "UPDATE evidence_bundles SET scan_red=1 WHERE id='evb_000001'")
        self.fails("append-only", "DELETE FROM evidence_bundles WHERE id='evb_000001'")

    # =========================== B. ledger: probes, premise, done means proven =========================
    def test_11_ledger_probe_immutable(self):
        self.base(); r = self.row(status="open")
        self.fails("probe is immutable", "UPDATE ledger_rows SET probe_spec='{\"cmd\":\"true\"}' WHERE id=?", r)
        self.fails("probe is immutable", "UPDATE ledger_rows SET probe_expected='{}' WHERE id=?", r)
        self.x("UPDATE ledger_rows SET title='Renamed' WHERE id=?", r)   # non-probe edits still fine

    def test_12_ledger_rows_never_deleted(self):
        self.base(); r = self.row(status="open")
        self.fails("never deleted", "DELETE FROM ledger_rows WHERE id=?", r)

    def test_13_ledger_ready_requires_failing_probe_and_valid_premise(self):
        self.base(); r = self.row(status="open")
        self.fails("premise_valid=1", "UPDATE ledger_rows SET status='ready' WHERE id=?", r)
        self.x("UPDATE ledger_rows SET premise_valid=1, premise_retested_at=?, last_probe_status='pass' WHERE id=?", iso(), r)
        self.fails("probe must fail today", "UPDATE ledger_rows SET status='ready' WHERE id=?", r)   # probe already passes: nothing to do
        self.x("UPDATE ledger_rows SET last_probe_status='fail' WHERE id=?", r)
        self.x("UPDATE ledger_rows SET status='ready' WHERE id=?", r)
        self.assertEqual(self.one("SELECT status FROM ledger_rows WHERE id=?", r), "ready")

    def test_14_ledger_illegal_transition_rejected(self):
        self.base(); r = self.row(status="open")
        self.fails("illegal ledger_row transition", "UPDATE ledger_rows SET status='running' WHERE id=?", r)
        self.fails("illegal ledger_row transition|done requires", "UPDATE ledger_rows SET status='done' WHERE id=?", r)   # two guards, either may fire first
        self.fails("illegal ledger_row transition|merging requires", "UPDATE ledger_rows SET status='merging' WHERE id=?", r)

    def test_15_ledger_done_requires_probe_pass_and_evidence(self):
        self.base(); r = self.row(status="verifying", merged_sha=SHA_B)   # non-merge style close from verifying is legal
        self.fails("last_probe_status=pass", "UPDATE ledger_rows SET status='done' WHERE id=?", r)
        self.x("UPDATE ledger_rows SET last_probe_status='pass' WHERE id=?", r)
        self.fails("evidence_bundle_id", "UPDATE ledger_rows SET status='done' WHERE id=?", r)
        self.bundle("evb_post", sha_=SHA_B)
        self.x("UPDATE ledger_rows SET status='done', evidence_bundle_id='evb_post', closed_at=? WHERE id=?", iso(), r)
        self.assertEqual(self.one("SELECT status FROM ledger_rows WHERE id=?", r), "done")

    def test_16_ledger_done_evidence_must_match_merged_sha_and_be_green(self):
        self.base(); r = self.row(status="verifying", merged_sha=SHA_B, last_probe_status="pass")
        self.bundle("evb_wrong", sha_=SHA_C)
        self.fails("bound to the merged SHA", "UPDATE ledger_rows SET status='done', evidence_bundle_id='evb_wrong' WHERE id=?", r)
        self.bundle("evb_red", sha_=SHA_B, red=1)
        self.fails("bound to the merged SHA", "UPDATE ledger_rows SET status='done', evidence_bundle_id='evb_red' WHERE id=?", r)
        # an agent can never be the capturer of evidence
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.bundle("evb_agent", sha_=SHA_B, captured="agent")

    def test_17_ledger_merging_requires_active_merge_slot(self):
        aid, ph, gid = self.approved_slot_world()
        self.fails("active merge_slot grant", "UPDATE ledger_rows SET status='merging' WHERE id='lr_000001'")
        self.activate(gid)
        self.x("UPDATE ledger_rows SET status='merging' WHERE id='lr_000001'")
        self.assertEqual(self.one("SELECT status FROM ledger_rows WHERE id='lr_000001'"), "merging")

    def test_18_ledger_watching_requires_sha_and_consumed_slot(self):
        aid, ph, gid = self.approved_slot_world(); self.activate(gid)
        self.x("UPDATE ledger_rows SET status='merging' WHERE id='lr_000001'")
        self.fails("merged_sha", "UPDATE ledger_rows SET status='watching' WHERE id='lr_000001'")
        self.fails("consumed merge_slot", "UPDATE ledger_rows SET status='watching', merged_sha=? WHERE id='lr_000001'", SHA_B)
        self.x("UPDATE grants SET status='consumed', consumed_at=? WHERE id=?", iso(), gid)
        self.x("UPDATE ledger_rows SET status='watching', merged_sha=?, watch_until=? WHERE id='lr_000001'", SHA_B, iso(-5))
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "consumed")   # approval is single-use

    def test_19_ledger_done_after_watch_requires_window_elapsed(self):
        aid, ph, gid = self.approved_slot_world(); self.activate(gid)
        self.x("UPDATE ledger_rows SET status='merging' WHERE id='lr_000001'")
        self.x("UPDATE grants SET status='consumed', consumed_at=? WHERE id=?", iso(), gid)
        self.x("UPDATE ledger_rows SET status='watching', merged_sha=?, watch_until=?, last_probe_status='pass' WHERE id='lr_000001'", SHA_B, iso(3600))
        self.bundle("evb_post", sha_=SHA_B)
        self.fails("watch window elapsed", "UPDATE ledger_rows SET status='done', evidence_bundle_id='evb_post' WHERE id='lr_000001'")
        self.x("UPDATE ledger_rows SET watch_until=? WHERE id='lr_000001'", iso(-1))
        self.x("UPDATE ledger_rows SET status='done', evidence_bundle_id='evb_post' WHERE id='lr_000001'")

    # =========================== C. work orders: maker != checker ======================================
    def test_20_wo_maker_and_checker_must_differ(self):
        self.base(); self.row()
        body = canonical({"budget": {"caps": {"max_usd": 1}}})
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.x("INSERT INTO work_orders(id,project_id,stream_id,ledger_row_id,title,body,content_hash,autonomy_tier,doer_agent_id,verifier_agent_id) "
                   "VALUES ('wo_x','prj_core1','stm_dev1','lr_000001','t',?,?,'L2','agt_work1','agt_work1')", body, sha(body))

    def test_21_wo_issue_gate(self):
        self.base(); self.row()
        self.agent("agt_sus1", "worker", status="suspended")
        self.agent("agt_wk2", "worker", "anthropic", "L1")
        body = canonical({"budget": {"caps": {"max_usd": 1}}})
        ins = ("INSERT INTO work_orders(id,project_id,stream_id,ledger_row_id,title,body,content_hash,autonomy_tier,doer_agent_id,verifier_agent_id,version) "
               "VALUES (?,'prj_core1','stm_dev1','lr_000001','t',?,?,?,?,?,?)")
        self.x(ins, "wo_a", body, sha(body), "L2", "agt_sus1", None, 1)
        self.fails("doer agent that is active", "UPDATE work_orders SET status='issued', issued_at=?, expires_at=? WHERE id='wo_a'", iso(), iso(60))
        self.x(ins, "wo_b", body, sha(body), "L2", "agt_wk2", None, 2)
        self.fails("exceeds the doer agent tier", "UPDATE work_orders SET status='issued', issued_at=?, expires_at=? WHERE id='wo_b'", iso(), iso(60))
        self.x(ins, "wo_c", body, sha(body), "L1", "agt_veri1", None, 3)
        self.fails("role worker", "UPDATE work_orders SET status='issued', issued_at=?, expires_at=? WHERE id='wo_c'", iso(), iso(60))
        self.x(ins, "wo_d", body, sha(body), "L1", "agt_work1", "agt_chief1", 4)
        self.fails("role verifier", "UPDATE work_orders SET status='issued', issued_at=?, expires_at=? WHERE id='wo_d'", iso(), iso(60))

    def test_22_wo_body_immutable_after_issue(self):
        self.base(); self.row(); w = self.wo()
        self.fails("immutable", "UPDATE work_orders SET body='{}' WHERE id=?", w)
        self.fails("immutable", "UPDATE work_orders SET autonomy_tier='L3' WHERE id=?", w)

    def test_23_wo_issued_requires_ttl(self):
        self.base(); self.row()
        body = canonical({"budget": {"caps": {"max_usd": 1}}})
        self.x("INSERT INTO work_orders(id,project_id,stream_id,ledger_row_id,title,body,content_hash,autonomy_tier,doer_agent_id) "
               "VALUES ('wo_t','prj_core1','stm_dev1','lr_000001','t',?,?,'L2','agt_work1')", body, sha(body))
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.x("UPDATE work_orders SET status='issued' WHERE id='wo_t'")   # no issued_at/expires_at: TTL is mandatory

    # =========================== D. runs, leases, single writer =======================================
    def test_24_verifier_cannot_run_as_doer_and_roles_are_pinned(self):
        self.base(); self.row(); self.wo()
        # a worker who is not the named doer may not run it either
        self.agent("agt_wk2", "worker")
        self.fails("must be by the work order", "INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,adapter_name,adapter_vendor) "
                   "VALUES ('run_w','wo_000001','prj_core1','stm_dev1','agt_wk2','x','anthropic')")
        # the named verifier may run (read-only review run) ...
        self.x("INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,adapter_name,adapter_vendor) "
               "VALUES ('run_ok','wo_000001','prj_core1','stm_dev1','agt_veri1','codex-cli','openai')")
        # ... but a different verifier agent may not
        self.agent("agt_veri2", "verifier", "google", "L1")
        self.fails("named verifier", "INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,adapter_name,adapter_vendor) "
                   "VALUES ('run_v2','wo_000001','prj_core1','stm_dev1','agt_veri2','x','google')")

    def test_25_run_admission_requires_active_lease(self):
        self.base(); self.row(); self.wo(); r = self.mkrun(lease=None)
        self.fails("active lease", "UPDATE runs SET status='starting' WHERE id=?", r)
        le = self.lease()
        self.x("UPDATE runs SET lease_id=? WHERE id=?", le, r)
        self.x("UPDATE runs SET status='starting' WHERE id=?", r)
        self.x("UPDATE runs SET status='running' WHERE id=?", r)

    def test_26_one_writer_per_artifact(self):
        self.base()
        self.agent("agt_wk2", "worker")
        self.lease("lse_1", key="wt:prj_core1:lr_1", fence=1, agent="agt_work1")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "UNIQUE"):
            self.lease("lse_2", key="wt:prj_core1:lr_1", fence=2, agent="agt_wk2")   # second concurrent writer
        self.x("UPDATE leases SET status='released', released_at=? WHERE id='lse_1'", iso())
        self.lease("lse_3", key="wt:prj_core1:lr_1", fence=2, agent="agt_wk2")       # fine after release
        self.lease("lse_4", key="wt:prj_core1:lr_other", fence=1, agent="agt_wk2")   # different artifact: fine

    def test_27_lease_fence_token_monotonic(self):
        self.base()
        self.lease("lse_1", fence=5)
        self.x("UPDATE leases SET status='expired' WHERE id='lse_1'")
        self.fails("fence_token must exceed", "INSERT INTO leases(id,resource_kind,resource_key,holder_agent_id,fence_token,expires_at) VALUES ('lse_2','worktree','wt:prj_core1:lr_000001','agt_work1',5,?)", iso(600))
        self.fails("fence_token must exceed", "INSERT INTO leases(id,resource_kind,resource_key,holder_agent_id,fence_token,expires_at) VALUES ('lse_2','worktree','wt:prj_core1:lr_000001','agt_work1',3,?)", iso(600))
        self.lease("lse_2", fence=6)

    def test_28_run_succeeded_requires_kernel_verified_artifact(self):
        r = self.running_run()
        self.x("UPDATE runs SET status='validating' WHERE id=?", r)
        self.fails("kernel-verified artifact", "UPDATE runs SET status='succeeded', result_hash=?, exit_code=0 WHERE id=?", sha("res"), r)
        # the agent CLAIMS a PR; the kernel has not verified it
        self.x("INSERT INTO run_artifacts(run_id,kind,ref,sha,claimed_by_agent,verified_by_kernel) VALUES (?, 'pull_request','https://git.invalid/core1/pull/7',?,1,0)", r, SHA_A)
        self.fails("kernel-verified artifact", "UPDATE runs SET status='succeeded', result_hash=?, exit_code=0 WHERE id=?", sha("res"), r)
        self.x("UPDATE run_artifacts SET verified_by_kernel=1, verified_at=? WHERE run_id=?", iso(), r)
        self.fails("result_hash and exit_code=0", "UPDATE runs SET status='succeeded' WHERE id=?", r)
        self.x("UPDATE runs SET status='succeeded', result_hash=?, exit_code=0 WHERE id=?", sha("res"), r)

    # =========================== E. budgets: hard stops ================================================
    def test_29_budget_caps_are_owner_set_and_always_hard(self):
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,max_usd,hard_stop,set_by) VALUES ('bud_1','fleet','all','day',10,0,?)", OWNER)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint|configured Owner"):   # an agent id is not an Owner id
            self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,max_usd,set_by) VALUES ('bud_1','fleet','all','day',10,'agt_work1')")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "configured Owner"):
            self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,max_usd,set_by) VALUES ('bud_1','fleet','all','day',10,'own_intruder')")
        self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,max_usd,set_by) VALUES ('bud_1','fleet','all','day',10,?)", OWNER)
        self.fails("bump version", "UPDATE budgets SET max_usd=1000 WHERE id='bud_1'")
        self.x("UPDATE budgets SET max_usd=20, version=2, set_by=? WHERE id='bud_1'", OWNER)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,set_by) VALUES ('bud_2','fleet','x','day',?)", OWNER)   # a budget must cap something

    def test_30_dispatch_refused_when_daily_budget_exhausted(self):
        self.base(); self.row(); self.wo(); le = self.lease(); r = self.mkrun(lease=le)
        self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,max_usd,set_by) VALUES ('bud_f','fleet','all','day',5,?)", OWNER)
        self.x("INSERT INTO spend_entries(id,project_id,kind,usd,idempotency_key) VALUES ('spd_1','prj_core1','model_tokens',5.0,'i1')")
        self.fails("budget exhausted", "UPDATE runs SET status='starting' WHERE id=?", r)

    def test_31_spend_over_run_cap_kills_the_run(self):
        r = self.running_run()                       # work order cap is $1.50
        self.x("INSERT INTO spend_entries(id,run_id,project_id,kind,usd,idempotency_key) VALUES ('spd_1',?,'prj_core1','model_tokens',1.00,'i1')", r)
        self.assertEqual(self.one("SELECT status FROM runs WHERE id=?", r), "running")
        self.x("INSERT INTO spend_entries(id,run_id,project_id,kind,usd,idempotency_key) VALUES ('spd_2',?,'prj_core1','model_tokens',0.60,'i2')", r)
        self.assertEqual(self.one("SELECT status FROM runs WHERE id=?", r), "killed")
        self.assertEqual(self.one("SELECT failure_class FROM runs WHERE id=?", r), "budget")

    def test_32_spend_exhausting_fleet_day_kills_every_running_run(self):
        r = self.running_run()
        self.x("INSERT INTO budgets(id,scope_kind,scope_id,period,max_usd,set_by) VALUES ('bud_f','fleet','all','day',2.0,?)", OWNER)
        self.x("INSERT INTO spend_entries(id,run_id,project_id,kind,usd,idempotency_key) VALUES ('spd_1',?,'prj_core1','model_tokens',1.0,'i1')", r)
        self.assertEqual(self.one("SELECT status FROM runs WHERE id=?", r), "running")
        self.x("INSERT INTO spend_entries(id,project_id,kind,usd,idempotency_key) VALUES ('spd_2','prj_core1','model_tokens',1.0,'i2')")   # spend by anything in scope
        self.assertEqual(self.one("SELECT status FROM runs WHERE id=?", r), "killed")

    # =========================== F. approvals: hash-bound, Owner only ==================================
    def test_33_approval_must_echo_the_payload_hash(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval()
        with self.assertRaises(sqlite3.DatabaseError):
            self.owner_approves(aid, ph, resp_hash=sha("a different payload"))
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "pending")
        self.owner_approves(aid, ph)
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "approved")

    def test_34_approval_after_expiry_rejected(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval(ttl=60)
        self.fails("expired before response", "UPDATE approvals SET status='approved', decision='approved', approver_id=?, method='deck_click', responded_at=?, response_payload_hash=? WHERE id=?",
                   OWNER, iso(120), ph, aid)

    def test_35_agents_and_strangers_cannot_approve(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval()
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint|configured Owner"):
            self.owner_approves(aid, ph, approver="agt_chief1")           # an agent id is never an approver
        with self.assertRaisesRegex(sqlite3.DatabaseError, "configured Owner"):
            self.owner_approves(aid, ph, approver="own_someone_else")      # looks like an owner, is not THE Owner
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "pending")

    def test_36_approval_payload_is_immutable(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval()
        self.fails("bound payload is immutable", "UPDATE approvals SET payload_hash=? WHERE id=?", sha("other"), aid)
        self.fails("bound payload is immutable", "UPDATE approvals SET head_sha=? WHERE id=?", SHA_C, aid)
        self.fails("never deleted", "DELETE FROM approvals WHERE id=?", aid)

    def test_37_red_scan_bundle_cannot_be_put_up_for_approval(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle(red=1)
        self.fails("red-scan", "INSERT INTO approvals(id,action_class,environment,tier,subject_kind,subject_ref,payload_hash,head_sha,evidence_bundle_id,requester_agent_id,request,expires_at) "
                   "VALUES ('apr_r','merge_main','production','L3','pull_request','u',?,?,?,'agt_chief1',?,?)",
                   sha("p"), SHA_A, "evb_000001", canonical({"work_order_id": "wo_000001"}), iso(600))

    def test_38_merge_approval_needs_independent_reviewer_bound_to_head(self):
        self.base(); self.row(); self.wo(); self.advance()
        self.bundle("evb_head", sha_=SHA_A)
        self.fails("bound to the approval head_sha", "INSERT INTO approvals(id,action_class,environment,tier,subject_kind,subject_ref,payload_hash,head_sha,evidence_bundle_id,requester_agent_id,request,expires_at) "
                   "VALUES ('apr_h','merge_main','production','L3','pull_request','u',?,?,?,'agt_chief1',?,?)",
                   sha("p"), SHA_B, "evb_head", canonical({"work_order_id": "wo_000001"}), iso(600))
        self.bundle("evb_self", sha_=SHA_A, reviewer="agt_work1")           # the maker "reviewed" its own work
        self.fails("independent_check", "INSERT INTO approvals(id,action_class,environment,tier,subject_kind,subject_ref,payload_hash,head_sha,evidence_bundle_id,requester_agent_id,request,expires_at) "
                   "VALUES ('apr_s','merge_main','production','L3','pull_request','u',?,?,?,'agt_chief1',?,?)",
                   sha("p"), SHA_A, "evb_self", canonical({"work_order_id": "wo_000001"}), iso(600))
        self.bundle("evb_rej", sha_=SHA_A, verdict="reject")
        self.fails("independent_check", "INSERT INTO approvals(id,action_class,environment,tier,subject_kind,subject_ref,payload_hash,head_sha,evidence_bundle_id,requester_agent_id,request,expires_at) "
                   "VALUES ('apr_j','merge_main','production','L3','pull_request','u',?,?,?,'agt_chief1',?,?)",
                   sha("p"), SHA_A, "evb_rej", canonical({"work_order_id": "wo_000001"}), iso(600))

    def test_39_challenge_and_step_up_requirements_are_enforced(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval("apr_c", challenge_required=1, challenge_kind="phrase", challenge_commitment=sha("salt+phrase"), challenge_channel="terminal")
        self.fails("challenge required", "UPDATE approvals SET status='approved', decision='approved', approver_id=?, method='deck_click', responded_at=?, response_payload_hash=? WHERE id='apr_c'", OWNER, iso(), ph)
        self.x("UPDATE approvals SET status='approved', decision='approved', approver_id=?, method='deck_challenge_phrase', responded_at=?, response_payload_hash=? WHERE id='apr_c'", OWNER, iso(), ph)
        aid2, ph2 = self.approval("apr_s", step_up_required=1, head=SHA_A)
        self.fails("step-up required", "UPDATE approvals SET status='approved', decision='approved', approver_id=?, method='deck_click', responded_at=?, response_payload_hash=? WHERE id='apr_s'", OWNER, iso(), ph2)

    # =========================== G. merge slot =========================================================
    def test_40_only_one_active_merge_slot_per_project_and_branch(self):
        aid, ph, g1 = self.approved_slot_world()
        self.bundle("evb_2", sha_=SHA_C)
        a2, p2 = self.approval("apr_000002", head=SHA_C, bundle="evb_2"); self.owner_approves(a2, p2)
        g2 = self.slot("grt_000002", aid=a2, head=SHA_C, pr=8)
        self.activate(g1)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "UNIQUE"):
            self.activate(g2)
        self.x("UPDATE grants SET status='consumed', consumed_at=? WHERE id=?", iso(), g1)
        self.activate(g2)                       # slot is free once the first landing is done

    def test_41_slot_activation_requires_approved_approval(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval()                    # still pending
        g = self.slot()
        self.fails("approved, unconsumed approval", "UPDATE grants SET status='active', issued_at=? WHERE id=?", iso(), g)
        self.owner_approves(aid, ph)
        self.activate(g)

    def test_42_slot_head_must_match_the_approved_head(self):
        self.base(); self.row(); self.wo(); self.advance(); self.bundle()
        aid, ph = self.approval(); self.owner_approves(aid, ph)
        g = self.slot(head=SHA_B)                    # grant claims a different head than the approval
        self.fails("must equal the approval head_sha", "UPDATE grants SET status='active', issued_at=? WHERE id=?", iso(), g)

    def test_43_head_sha_change_voids_the_slot_and_supersedes_the_approval(self):
        aid, ph, g = self.approved_slot_world(); self.activate(g)
        self.x("UPDATE grants SET observed_head_sha=? WHERE id=?", SHA_C, g)   # the agent pushed another commit
        self.assertEqual(self.one("SELECT status FROM grants WHERE id=?", g), "void")
        self.assertEqual(self.one("SELECT void_reason FROM grants WHERE id=?", g), "head_sha_changed")
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "superseded")
        self.fails("illegal grant transition", "UPDATE grants SET status='active' WHERE id=?", g)          # void is terminal
        self.fails("illegal approval transition", "UPDATE approvals SET status='approved' WHERE id=?", aid)  # approval can never be reused

    def test_44_head_change_while_pending_also_voids(self):
        aid, ph, g = self.approved_slot_world()
        self.x("UPDATE grants SET observed_head_sha=? WHERE id=?", SHA_B, g)
        self.assertEqual(self.one("SELECT status FROM grants WHERE id=?", g), "void")

    def test_45_unchanged_head_observation_does_not_void(self):
        aid, ph, g = self.approved_slot_world(); self.activate(g)
        self.x("UPDATE grants SET observed_head_sha=? WHERE id=?", SHA_A, g)
        self.assertEqual(self.one("SELECT status FROM grants WHERE id=?", g), "active")

    def test_46_approval_is_single_use(self):
        aid, ph, g = self.approved_slot_world(); self.activate(g)
        self.x("UPDATE grants SET status='consumed', consumed_at=? WHERE id=?", iso(), g)
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "consumed")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "UNIQUE"):
            self.slot("grt_again", aid=aid, pr=7)           # a second grant on a used approval

    def test_47_grant_binding_is_immutable(self):
        aid, ph, g = self.approved_slot_world()
        self.fails("binding is immutable", "UPDATE grants SET approved_head_sha=? WHERE id=?", SHA_C, g)
        self.fails("binding is immutable", "UPDATE grants SET pr_number=99 WHERE id=?", g)

    # =========================== H. kill switch ========================================================
    def test_48_kill_switch_blocks_new_runs_leases_and_approvals(self):
        self.base(); self.row(); self.wo(); self.bundle()
        aid, ph = self.approval()
        self.x("UPDATE settings SET value='{\"engaged\":true}', updated_by=? WHERE key='kill_switch'", OWNER)
        self.fails("kill switch is engaged", "INSERT INTO leases(id,resource_kind,resource_key,holder_agent_id,fence_token,expires_at) VALUES ('lse_k','worktree','k','agt_work1',1,?)", iso(60))
        self.fails("kill switch is engaged", "INSERT INTO runs(id,work_order_id,project_id,stream_id,agent_id,adapter_name,adapter_vendor) VALUES ('run_k','wo_000001','prj_core1','stm_dev1','agt_work1','x','anthropic')")

    def test_49_kill_switch_cascades_in_one_transaction(self):
        r = self.running_run()
        self.bundle(); aid, ph = self.approval(); self.owner_approves(aid, ph); g = self.slot()
        self.activate(g)
        # a second, still-pending approval too
        self.bundle("evb_2", sha_=SHA_C); a2, _ = self.approval("apr_000002", head=SHA_C, bundle="evb_2")
        self.x("UPDATE settings SET value='{\"engaged\":true}', updated_by='system' WHERE key='kill_switch'")   # the system may engage
        self.assertEqual(self.one("SELECT status FROM runs WHERE id=?", r), "killed")
        self.assertEqual(self.one("SELECT COUNT(*) FROM leases WHERE status='active'"), 0)
        self.assertEqual(self.one("SELECT status FROM grants WHERE id=?", g), "revoked")
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", aid), "revoked")
        self.assertEqual(self.one("SELECT status FROM approvals WHERE id=?", a2), "revoked")

    def test_50_only_the_owner_releases_the_kill_switch(self):
        self.x("UPDATE settings SET value='{\"engaged\":true}', updated_by='system' WHERE key='kill_switch'")
        self.fails("only the Owner may release", "UPDATE settings SET value='{\"engaged\":false}', updated_by='system' WHERE key='kill_switch'")
        self.fails("only the Owner may release", "UPDATE settings SET value='{\"engaged\":false}', updated_by='agt_work1' WHERE key='kill_switch'")
        self.x("UPDATE settings SET value='{\"engaged\":false}', updated_by=? WHERE key='kill_switch'", OWNER)

    def test_51_tier0_settings_and_policy_are_owner_only(self):
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.x("UPDATE settings SET value='\"L5\"', updated_by='agt_chief1' WHERE key='autonomy.max_global_tier'")
        self.x("UPDATE settings SET value='\"L4\"', updated_by=? WHERE key='autonomy.max_global_tier'", OWNER)
        rule = ("INSERT INTO policy_rules(id,version,priority,effect,match,reason,rule_hash,created_by) VALUES ('pol_0010',1,10,'deny','{}','Agents never edit gates',?,?)")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint|configured Owner"):
            self.x(rule, sha("r"), "agt_chief1")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "configured Owner"):
            self.x(rule, sha("r"), "own_intruder")
        self.x(rule, sha("r"), OWNER)
        self.fails("immutable", "UPDATE policy_rules SET effect='allow' WHERE id='pol_0010'")
        self.fails("never deleted", "DELETE FROM policy_rules WHERE id='pol_0010'")

    # =========================== I. decision cards =====================================================
    def test_52_decision_cards(self):
        self.base()
        with self.assertRaisesRegex(sqlite3.DatabaseError, "CHECK constraint"):
            self.x("INSERT INTO decision_cards(id,variant,title,ask,urgency,default_on_timeout,body) VALUES ('dcd_1','approve','t','a','today','deny','{}')")  # approve needs an approval
        self.x("INSERT INTO decision_cards(id,variant,title,ask,urgency,default_on_timeout,body) VALUES ('dcd_2','choose','Pick a dependency','which?','today','safe_default','{}')")
        self.fails("configured Owner", "UPDATE decision_cards SET status='answered', answered_by='own_other', answered_at=? WHERE id='dcd_2'", iso())
        self.x("UPDATE decision_cards SET status='answered', answered_by=?, answered_at=?, answer='{\"option\":1}' WHERE id='dcd_2'", OWNER, iso())

    # =========================== J. Core is a strict subset of the full schema =========================
    @unittest.skipUnless(FULL_SQL_PATH.exists(), "full schema not present next to core/ (standalone Core repo)")
    def test_53_core_tables_are_a_strict_subset_of_the_full_schema(self):
        full = sqlite3.connect(":memory:")
        full.executescript(FULL_SQL_PATH.read_text())
        tables = [r[0] for r in self.x("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        self.assertGreaterEqual(len(tables), 20)
        problems = []
        for t in tables:
            core_cols = {r[1]: (r[2], r[3], r[4]) for r in self.x("PRAGMA table_info(%s)" % t)}
            full_cols = {r[1]: (r[2], r[3], r[4]) for r in full.execute("PRAGMA table_info(%s)" % t)}
            if not full_cols:
                problems.append("table %s missing from full schema" % t)
                continue
            for c, spec in core_cols.items():
                if c not in full_cols:
                    problems.append("%s.%s not in full schema" % (t, c))
                elif full_cols[c][0] != spec[0] or full_cols[c][1] != spec[1]:
                    problems.append("%s.%s type/notnull differs: core=%s full=%s" % (t, c, spec[:2], full_cols[c][:2]))
        self.assertEqual(problems, [])
        # ... and the state machines and event vocabulary are copies, not re-inventions
        core_tr = set(self.x("SELECT machine,from_state,to_state FROM legal_transitions"))
        full_tr = set(full.execute("SELECT machine,from_state,to_state FROM legal_transitions"))
        self.assertTrue(core_tr <= full_tr)
        core_ev = set(self.x("SELECT type,producer FROM event_types"))
        full_ev = set(full.execute("SELECT type,producer FROM event_types"))
        self.assertTrue(core_ev <= full_ev)

    def test_54_core_event_vocabulary_is_small_and_closed(self):
        n = self.one("SELECT COUNT(*) FROM event_types")
        self.assertEqual(n, 88)
        groups = self.one("SELECT COUNT(DISTINCT substr(type,1,instr(type,'.')-1)) FROM event_types")
        self.assertEqual(groups, 25)


if __name__ == "__main__":
    unittest.main(verbosity=2)
