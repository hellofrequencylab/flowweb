// Backlog verify_probe for FW-C-006: `pnpm probe cli/skeleton`. Thin wrapper (Tier 0) that runs the C0
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
// probe-timeout-s: 240 (runs c0/cli-skeleton, about 30 s on Linux and 57 s on macOS)
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/cli-skeleton"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
