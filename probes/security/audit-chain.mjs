// Backlog verify_probe for WS-P0-023: `pnpm probe security/audit-chain`. Thin wrapper (Tier 0) that runs the C0
// probe proving this row, so the backlog command resolves. See probes/c0/README.md.
// probe-timeout-s: 240 (runs c0/audit-chain, 14 s on Linux, 34 s on macOS alone and over 60 s under load)
import { runProbe } from '../c0/_lib.mjs';

const targets = ["c0/audit-chain"];
let code = 0;
for (const t of targets) code = runProbe(t) || code;
process.exit(code);
