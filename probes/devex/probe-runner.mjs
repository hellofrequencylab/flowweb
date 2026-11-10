// Backlog verify_probe for WS-P0-006: `pnpm probe devex/probe-runner`. Thin wrapper (Tier 0) that runs the C0
// probe-timeout-s: 300 (runs c0/probe-runner, which takes over a minute)
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/probe-runner"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
