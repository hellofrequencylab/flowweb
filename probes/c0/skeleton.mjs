// Probe c0/skeleton (FW-C-001): exactly eight @fw packages exist and resolve, boundary lint is clean,
// and a deliberate forbidden import (cli -> eventlog) makes the boundary lint fail.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = process.env.FW_REPO_ROOT ?? process.cwd();
const expected = ['adapters', 'cli', 'contracts', 'daemon', 'eventlog', 'ledger', 'policy', 'web'];
assert.deepEqual(readdirSync(join(root, 'packages')).sort(), expected, 'exactly eight packages');
for (const p of expected) {
  const mod = await import(join(root, 'packages', p, 'src', 'index.ts'));
  assert.ok(mod, `@fw/${p} resolves`);
}
const lint = spawnSync(process.execPath, [join(root, 'scripts/boundary-lint.mjs'), root], { encoding: 'utf8' });
assert.equal(lint.status, 0, `boundary lint clean: ${lint.stderr}`);

const tmp = mkdtempSync(join(tmpdir(), 'fw-skel-'));
cpSync(join(root, 'packages'), join(tmp, 'packages'), { recursive: true, filter: (s) => !s.includes('node_modules') });
writeFileSync(join(tmp, 'packages/cli/src/bad.ts'), "import '@fw/eventlog';\n");
const bad = spawnSync(process.execPath, [join(root, 'scripts/boundary-lint.mjs'), tmp], { encoding: 'utf8' });
assert.equal(bad.status, 1, 'a forbidden import makes the boundary lint exit 1');
console.log('c0/skeleton: eight packages resolve; boundary lint enforced');
