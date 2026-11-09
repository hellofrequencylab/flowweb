// Backlog verify_probe for WS-P1-003: `pnpm probe kernel/stream-model`. Thin wrapper (Tier 0) that runs the C1
// probe proving this row, so the backlog command resolves. See probes/c1/README.md.
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c1/stream-model"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
