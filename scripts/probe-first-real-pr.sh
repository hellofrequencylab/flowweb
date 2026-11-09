#!/usr/bin/env bash
# Probe for row WS-P0-043 (human, pair): the walking skeleton on a real repo with a real vendor. Tier 0.
# Run after `fw run start <row>` against the real repository with a real vendor adapter.
#
# Inputs:
#   FW_HOME        the FlowWeb home that ran the row (default ~/.flowweb)
#   FW_REAL_ROW    the row id that was run (for example FW-C-006)
#   FW_GH_REPO     owner/repo where the PR was opened (default: current checkout's repo)
# Acceptance:
#   - a real PR exists, its head SHA equals the kernel-verified artifact, and it carries the
#     evidence bundle comment with the bundle hash
#   - the audit chain verifies (fw audit verify)
#   - the run's cost is under the row's work-order cap, and an earlier smoke run by a real vendor
#     ran under a hard cap of 0.50 USD (core_adaptation, old WS-P0-031)
set -euo pipefail

fail() { echo "FAIL probe-first-real-pr: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${FW_HOME:-$HOME/.flowweb}"
DB="$HOME_DIR/db/fw.sqlite"
ROW="${FW_REAL_ROW:-}"
[ -n "$ROW" ] || fail "set FW_REAL_ROW to the row id that was run"
[ -f "$DB" ] || fail "no database at $DB (set FW_HOME)"
command -v gh >/dev/null || fail "gh CLI not installed"
REPO="${FW_GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
[ -n "$REPO" ] || fail "set FW_GH_REPO=owner/repo"

# q <sql> [params...]: one JSON row (or null) from the database, read-only.
q() {
  python3 -I - "$DB" "$@" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
db.row_factory = sqlite3.Row
r = db.execute(sys.argv[2], sys.argv[3:]).fetchone()
print(json.dumps(dict(r) if r else None))
PY
}
field() { python3 -I -c 'import json,sys; v=json.loads(sys.argv[1]); print("" if v is None else v.get(sys.argv[2]) if v.get(sys.argv[2]) is not None else "")' "$1" "$2"; }

RUN="$(q "SELECT r.id, r.status, r.adapter_vendor, r.work_order_id FROM runs r JOIN work_orders w ON w.id = r.work_order_id JOIN ledger_rows l ON l.id = w.ledger_row_id WHERE l.id = 'lr_' || replace(?, '-', '') AND r.adapter_vendor IN ('anthropic','openai') ORDER BY r.queued_at DESC LIMIT 1" "$ROW")"
[ "$RUN" != "null" ] || fail "no real-vendor run found for $ROW (the row id is lr_ plus the code without hyphens)"
RUN_ID="$(field "$RUN" id)"
[ "$(field "$RUN" status)" = "succeeded" ] || fail "run $RUN_ID is $(field "$RUN" status), want succeeded"
ok "run $RUN_ID by $(field "$RUN" adapter_vendor) succeeded"

ART="$(q "SELECT ref, sha FROM run_artifacts WHERE run_id = ? AND kind = 'pull_request' AND verified_by_kernel = 1" "$RUN_ID")"
[ "$ART" != "null" ] || fail "run $RUN_ID has no kernel-verified pull_request artifact"
PR_URL="$(field "$ART" ref)"; PR_SHA="$(field "$ART" sha)"
HEAD="$(gh pr view "$PR_URL" -R "$REPO" --json headRefOid --jq .headRefOid)" || fail "PR $PR_URL not found on $REPO"
[ "$HEAD" = "$PR_SHA" ] || fail "PR head $HEAD differs from the verified artifact $PR_SHA"
ok "PR $PR_URL exists at $PR_SHA"

EVB="$(q "SELECT bundle_hash FROM evidence_bundles WHERE subject_sha = ? ORDER BY created_at DESC LIMIT 1" "$PR_SHA")"
[ "$EVB" != "null" ] || fail "no evidence bundle bound to $PR_SHA"
HASH="$(field "$EVB" bundle_hash)"
gh pr view "$PR_URL" -R "$REPO" --json comments --jq '.comments[].body' | grep -q "$HASH" \
  || fail "no PR comment carries the evidence bundle hash $HASH"
ok "evidence comment carries bundle hash $HASH"

(cd "$ROOT" && FW_HOME="$HOME_DIR" pnpm -s fw audit verify --json >/dev/null) || fail "fw audit verify reports a broken chain"
ok "audit chain verifies"

COST="$(q "SELECT COALESCE(SUM(usd), -1) AS usd FROM spend_entries WHERE run_id = ?" "$RUN_ID")"
CAP="$(q "SELECT json_extract(body, '\$.budget.caps.max_usd') AS cap FROM work_orders WHERE id = ?" "$(field "$RUN" work_order_id)")"
python3 -I -c 'import sys; c=float(sys.argv[1]); cap=float(sys.argv[2]); sys.exit(0 if 0 <= c <= cap else 1)' \
  "$(field "$COST" usd)" "$(field "$CAP" cap)" || fail "run cost $(field "$COST" usd) USD is unknown or over the cap $(field "$CAP" cap) USD"
ok "cost $(field "$COST" usd) USD under cap $(field "$CAP" cap) USD"

SMOKE="$(q "SELECT r.id FROM runs r JOIN work_orders w ON w.id = r.work_order_id WHERE r.adapter_vendor IN ('anthropic','openai') AND json_extract(w.body, '\$.budget.caps.max_usd') <= 0.5 AND r.queued_at < (SELECT queued_at FROM runs WHERE id = ?) LIMIT 1" "$RUN_ID")"
[ "$SMOKE" != "null" ] || fail "no earlier real-vendor smoke run under a 0.50 USD cap"
ok "smoke run $(field "$SMOKE" id) ran under a 0.50 USD cap first"

echo "PASS probe-first-real-pr ($ROW, $PR_URL)"
