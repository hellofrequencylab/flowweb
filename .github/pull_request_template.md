<!-- One ledger row per PR. Plain English. Delete nothing; write "n/a" if a field does not apply. -->

## Ledger row
`WS-Pn-nnn` or `FW-C-nnn` (exactly one; housekeeping PRs add the `housekeeping` label instead)

## What changed, in plain English
<!-- What does a person get, or what stops being wrong? One to three sentences. -->

## Probe
Command: `pnpm probe <path>`

Before (on main, must fail):
```
<paste output>
```
After (on this branch, must pass):
```
<paste output>
```

## Scope check
- [ ] Only files in the row's `files_hint` changed
- [ ] No edits to Tier 0 paths (or this is a `pair` row, draft, and the Owner is reviewing line by line)
- [ ] No tests or probes deleted, skipped or loosened; no thresholds, budgets or baselines raised
- [ ] No secrets, tokens or personal data in the diff, fixtures or logs
- [ ] No new dependency (or the row allows it and it is pinned)
- [ ] Size within the cap for the row size: S 150, M 400, L 600 changed lines

## Tier touched
<!-- none | Tier 0 (needs Owner approval) | Tier 1 | Tier 2 -->

## Evidence
Evidence bundle id and hash:
Independent verifier result (advisory) and whether it was a different vendor:
Cost of this run (tokens, dollars):

## Definition of done
- [ ] CI green
- [ ] Docs or changelog updated if behaviour changed
- [ ] Rollback is a plain revert (or the rollback note is below)

## Rollback / blast radius
<!-- What breaks if this is wrong, and how to undo it. -->
