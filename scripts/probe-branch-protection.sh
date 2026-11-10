#!/usr/bin/env bash
# Probe for row WS-P0-003 (human): branch protection and code-owner review on main. Tier 0.
# Reads the live settings (classic branch protection and rulesets) through `gh api`; changes nothing.
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

# Protection can come from classic branch protection, from rulesets, or both. A requirement counts
# only when a source that nobody can bypass enforces it: classic protection with enforce_admins on, or
# an active ruleset with no bypass actors. Each source is read through `gh api`.
CLASSIC="$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>/dev/null)" || CLASSIC=null
RULES="$(gh api "repos/$REPO/rules/branches/$BRANCH" 2>/dev/null)" || fail "cannot read the rules for $REPO:$BRANCH"
RULESETS="[]"
for id in $(printf '%s' "$RULES" | python3 -I -c 'import json,sys; print(" ".join(sorted({str(r["ruleset_id"]) for r in json.load(sys.stdin) if "ruleset_id" in r})))'); do
  one="$(gh api "repos/$REPO/rulesets/$id" 2>/dev/null)" || fail "cannot read ruleset $id (its bypass list decides whether it counts)"
  RULESETS="$(printf '%s\n%s' "$RULESETS" "$one" | python3 -I -c 'import json,sys; a,b=sys.stdin.read().split("\n",1); print(json.dumps(json.loads(a)+[json.loads(b)]))')"
done
# Prints one line per requirement: "<key> <true|false> <detail>", from the sources that cannot be bypassed.
EFFECTIVE="$(python3 -I -c '
import json, sys
classic, rules, rulesets = (json.loads(x) for x in sys.argv[1:4])
solid = {r["id"] for r in rulesets if r.get("enforcement") == "active" and not r.get("bypass_actors")}
bypass = sorted({json.dumps(a, sort_keys=True) for r in rulesets for a in (r.get("bypass_actors") or [])})
rules = [r for r in rules if r.get("ruleset_id") in solid]
c = classic if isinstance(classic, dict) and (classic.get("enforce_admins") or {}).get("enabled") else {}
pr = [r.get("parameters", {}) for r in rules if r["type"] == "pull_request"]
cr = c.get("required_pull_request_reviews") or {}
count = max([p.get("required_approving_review_count", 0) for p in pr] + [cr.get("required_approving_review_count", 0)])
checks = {x["context"] for r in rules if r["type"] == "required_status_checks" for x in r["parameters"].get("required_status_checks", [])}
checks |= set((c.get("required_status_checks") or {}).get("contexts") or [])
types = {r["type"] for r in rules}
out = {
  "code_owner": any(p.get("require_code_owner_review") for p in pr) or bool(cr.get("require_code_owner_reviews")),
  "dismiss_stale": any(p.get("dismiss_stale_reviews_on_push") for p in pr) or bool(cr.get("dismiss_stale_reviews")),
  "approvals": count >= 1,
  "no_bypass": bool(c) or bool(rules),
  "no_force_push": "non_fast_forward" in types or (c.get("allow_force_pushes") or {}).get("enabled") is False,
  "no_deletion": "deletion" in types or (c.get("allow_deletions") or {}).get("enabled") is False,
}
for k, v in out.items(): print(k, str(v).lower(), count if k == "approvals" else "")
print("checks", " ".join(sorted(checks)))
print("bypass", " ".join(bypass) or "-")
' "$CLASSIC" "$RULES" "$RULESETS")"
e() { printf '%s\n' "$EFFECTIVE" | awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print }'; }
[ "$(e no_bypass)" = "true" ] || fail "nothing protects $BRANCH without a bypass (no classic protection with enforce_admins, no active ruleset without bypass actors; bypass actors: $(e bypass))"
ok "protection that admins cannot bypass"
[ "$(e code_owner)" = "true" ] || fail "code-owner review is not required"
ok "code-owner review required"
[ "$(e dismiss_stale)" = "true" ] || fail "stale approvals are not dismissed"
ok "stale approvals dismissed"
COUNT="$(e approvals | awk '{print $2}')"
[ "$(e approvals | awk '{print $1}')" = "true" ] || fail "required approving review count is $COUNT, want >= 1"
ok "at least one approving review required"
[ "$(e no_force_push)" = "true" ] || fail "force pushes to $BRANCH are allowed"
[ "$(e no_deletion)" = "true" ] || fail "deleting $BRANCH is allowed"
ok "no force push, no deletion"
CONTEXTS=" $(e checks) "
for c in $CHECKS; do
  case "$CONTEXTS" in *" $c "*) ;; *) fail "required status check '$c' is not required on $BRANCH" ;; esac
done
ok "required checks: $CHECKS"
BYPASS="$(printf '%s' "$CLASSIC" | python3 -I -c 'import json,sys; v=json.load(sys.stdin) or {}; print(json.dumps(((v.get("required_pull_request_reviews") or {}).get("bypass_pull_request_allowances")) or {}))')"

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
