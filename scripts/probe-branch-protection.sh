#!/usr/bin/env bash
# Probe for row WS-P0-003 (human): branch protection and code-owner review on main. Tier 0.
# Reads the live settings through `gh api`; changes nothing.
#
# Inputs:
#   FW_GH_REPO        owner/repo (default: the repo of the current checkout, via gh repo view)
#   FW_AGENT_TOKEN    a token of the agent identity (bot or fine-grained PAT) used by runs; required
#   FW_REQUIRED_CHECKS  space-separated CI job names that must be required
#                     (default: checks schema-and-contracts tier0-guard probe-immutability ledger-row)
# Acceptance:
#   - direct push to main is rejected: protection exists, PRs are required, force push and
#     deletion are off, admins are included (no bypass)
#   - a PR touching a Tier 0 path cannot merge without a human code-owner approval: code-owner
#     review required, stale approvals dismissed, CODEOWNERS has no errors on GitHub
#   - the agent identity token has no admin permission and is not on any bypass list
# Exit 0 only when every check passes. A missing input is a failure, never a skip.
set -euo pipefail

fail() { echo "FAIL probe-branch-protection: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

command -v gh >/dev/null || fail "gh CLI not installed"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated (gh auth login)"
REPO="${FW_GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
[ -n "$REPO" ] || fail "set FW_GH_REPO=owner/repo"
BRANCH=main
CHECKS="${FW_REQUIRED_CHECKS:-checks schema-and-contracts tier0-guard probe-immutability ledger-row}"

P="$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>/dev/null)" || fail "no branch protection on $REPO:$BRANCH"
# j <dotted.path>: JSON value at that path in the protection document ("null" when absent).
j() {
  printf '%s' "$P" | python3 -I -c '
import json, sys
v = json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print(json.dumps(v))' "$1"
}

[ "$(j required_pull_request_reviews.require_code_owner_reviews)" = "true" ] || fail "code-owner review is not required"
ok "code-owner review required"
[ "$(j required_pull_request_reviews.dismiss_stale_reviews)" = "true" ] || fail "stale approvals are not dismissed"
ok "stale approvals dismissed"
COUNT="$(j required_pull_request_reviews.required_approving_review_count)"
[ "$COUNT" != "null" ] && [ "$COUNT" -ge 1 ] || fail "required approving review count is $COUNT, want >= 1"
ok "at least one approving review required"
[ "$(j enforce_admins.enabled)" = "true" ] || fail "admins can bypass protection (enforce_admins off)"
ok "admins included"
[ "$(j allow_force_pushes.enabled)" = "false" ] || fail "force pushes to $BRANCH are allowed"
[ "$(j allow_deletions.enabled)" = "false" ] || fail "deleting $BRANCH is allowed"
ok "no force push, no deletion"
CONTEXTS="$(j required_status_checks.contexts)"
for c in $CHECKS; do
  printf '%s' "$CONTEXTS" | grep -q "\"$c\"" || fail "required status check '$c' is not required on $BRANCH"
done
ok "required checks: $CHECKS"
BYPASS="$(j required_pull_request_reviews.bypass_pull_request_allowances)"

ERRS="$(gh api "repos/$REPO/codeowners/errors" --jq '.errors | length' 2>/dev/null)" || fail "cannot read CODEOWNERS errors"
[ "$ERRS" = "0" ] || fail "GitHub reports $ERRS CODEOWNERS error(s)"
ok "CODEOWNERS parses cleanly on GitHub"

[ -n "${FW_AGENT_TOKEN:-}" ] || fail "set FW_AGENT_TOKEN to the agent identity's token to check its permissions"
AGENT_LOGIN="$(GH_TOKEN="$FW_AGENT_TOKEN" gh api user --jq .login 2>/dev/null || GH_TOKEN="$FW_AGENT_TOKEN" gh api /installation/repositories --jq '"app-installation"' 2>/dev/null || true)"
[ -n "$AGENT_LOGIN" ] || fail "FW_AGENT_TOKEN does not authenticate"
ADMIN="$(GH_TOKEN="$FW_AGENT_TOKEN" gh api "repos/$REPO" --jq '.permissions.admin // false')"
[ "$ADMIN" = "false" ] || fail "the agent identity ($AGENT_LOGIN) has admin permission on $REPO"
MAINTAIN="$(GH_TOKEN="$FW_AGENT_TOKEN" gh api "repos/$REPO" --jq '.permissions.maintain // false')"
[ "$MAINTAIN" = "false" ] || fail "the agent identity ($AGENT_LOGIN) has maintain permission on $REPO"
printf '%s' "$BYPASS" | grep -q "\"$AGENT_LOGIN\"" && fail "the agent identity ($AGENT_LOGIN) is on the PR review bypass list"
ok "agent identity $AGENT_LOGIN: no admin, no maintain, no bypass"

echo "PASS probe-branch-protection ($REPO:$BRANCH)"
