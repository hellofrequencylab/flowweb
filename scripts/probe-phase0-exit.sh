#!/usr/bin/env bash
# Probe for row WS-P0-044 (human): C0 exit demo and review. Tier 0.
#
# Inputs:
#   FW_REAL_ROW, FW_GH_REPO, FW_HOME   as for scripts/probe-first-real-pr.sh
#   FW_DEMO_RUN=1                      also run scripts/demo-p0.sh from a clean clone (slow, real vendor)
# Acceptance:
#   - scripts/demo-p0.sh exists and, with FW_DEMO_RUN=1, runs end to end from a clean clone
#   - the exit checklist in docs/milestone-reviews/C0.md is fully ticked (no "- [ ]" left)
#   - kill criteria are evaluated and recorded (a "Kill criteria" section with a verdict line)
#   - the C0 exit rows' probes pass: c0/walking-skeleton-ci (WS-P0-042), the first real PR
#     (WS-P0-043) and a clean chain (WS-P0-023: c0/audit-chain)
set -euo pipefail

fail() { echo "FAIL probe-phase0-exit: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW="$ROOT/docs/milestone-reviews/C0.md"
DEMO="$ROOT/scripts/demo-p0.sh"

[ -f "$DEMO" ] || fail "scripts/demo-p0.sh does not exist"
[ -f "$REVIEW" ] || fail "docs/milestone-reviews/C0.md does not exist"
grep -q -- '- \[x\]' "$REVIEW" || fail "the C0 review has no ticked checklist items"
if grep -q -- '- \[ \]' "$REVIEW"; then
  fail "the C0 exit checklist has unticked items: $(grep -c -- '- \[ \]' "$REVIEW")"
fi
ok "exit checklist fully ticked"
grep -qi '^#\+ *kill criteria' "$REVIEW" || fail "no 'Kill criteria' section in the C0 review"
grep -qiE '^(verdict|decision):' "$REVIEW" || fail "kill criteria have no recorded verdict line (Verdict: ... or Decision: ...)"
ok "kill criteria evaluated and recorded"

if [ "${FW_DEMO_RUN:-0}" = "1" ]; then
  CLONE="$(mktemp -d)/clone"
  git clone -q "$(git -C "$ROOT" remote get-url origin)" "$CLONE" || fail "cannot clone the repo for the demo"
  (cd "$CLONE" && bash scripts/demo-p0.sh) || fail "scripts/demo-p0.sh failed from a clean clone"
  ok "demo ran end to end from a clean clone"
else
  echo "note: set FW_DEMO_RUN=1 to run the demo from a clean clone (required for the exit review)"
fi

(cd "$ROOT" && pnpm -s probe c0/walking-skeleton-ci) || fail "c0/walking-skeleton-ci (WS-P0-042) fails"
bash "$ROOT/scripts/probe-first-real-pr.sh" || fail "scripts/probe-first-real-pr.sh (WS-P0-043) fails"
(cd "$ROOT" && pnpm -s probe c0/audit-chain) || fail "c0/audit-chain (WS-P0-023) fails"
[ "${FW_DEMO_RUN:-0}" = "1" ] || fail "the demo was not run (FW_DEMO_RUN=1); the exit review needs it"

echo "PASS probe-phase0-exit"
