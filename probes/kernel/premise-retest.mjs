// Backlog verify_probe for WS-P0-020: `pnpm probe kernel/premise-retest`. Thin wrapper (Tier 0) that runs the C0
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/premise-retest"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
