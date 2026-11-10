// Backlog verify_probe for WS-P0-042: `pnpm probe e2e/walking-skeleton-ci`. Thin wrapper (Tier 0) that runs the C0
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
// probe-timeout-s: 240 (runs c0/walking-skeleton-ci, about 34 s on Linux and over 60 s on macOS)
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/walking-skeleton-ci"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
