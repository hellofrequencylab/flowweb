// Probe c0/bootstrap (WS-P0-002). The row's verify_probe is `node scripts/check-bootstrap.mjs`; this
// wrapper exists so the C0 status table can run every row the same way.
// Acceptance: CLAUDE.md imports AGENTS.md; CODEOWNERS lists every Tier 0 path from AGENTS.md;
// the PR template has the ledger-row, probe-output and tier-touched fields.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './_lib.mjs';

const r = spawnSync(process.execPath, [join(root, 'scripts/check-bootstrap.mjs'), root], { stdio: 'inherit' });
process.exit(r.status ?? 1);
