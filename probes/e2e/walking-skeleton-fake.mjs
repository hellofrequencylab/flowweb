// Backlog verify_probe for WS-P0-041: `pnpm probe e2e/walking-skeleton-fake`. Thin wrapper (Tier 0) that runs the C0
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/run-fake-e2e","c0/diff-policy-run"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
