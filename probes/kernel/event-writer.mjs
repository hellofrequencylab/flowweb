// Backlog verify_probe for FW-C-004: `pnpm probe kernel/event-writer`. Thin wrapper (Tier 0) that runs the C0
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/event-chain"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
