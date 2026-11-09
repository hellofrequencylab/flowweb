@AGENTS.md

Claude-specific notes:
- Use plan mode before any row sized L, and put the plan in the PR description.
- Prefer small, reviewable diffs. If your diff passes the cap for the row (S 150, M 400, L 600 changed lines), stop and split.
- Run the row's premise re-test and its probe yourself and paste the output.
- When the Owner says "sync the ledger", run `pnpm fw ledger sync` and follow `ledger/rows/README.md`.
- You are a maker. A different agent (ideally a different vendor) verifies your work; do not review your own diff and call that verification.
