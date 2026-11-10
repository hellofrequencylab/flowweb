// Backlog verify_probe for WS-P1-016: `pnpm probe adapters/routing`. Thin wrapper (Tier 0) that runs the C1
// probe proving this row, so the backlog command resolves. See probes/c1/README.md.
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c1/routing"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
