// Probe c0/workspace-layout (FW-C-001; backlog verify_probe devex/workspace-layout).
// Proves the row's acceptance lines:
//   - pnpm install --frozen-lockfile succeeds (checked as: the lockfile satisfies package.json, offline)
//   - pnpm typecheck passes with strict, noUncheckedIndexedAccess and exactOptionalPropertyTypes on
//   - a deliberate import of @fw/adapters from @fw/ledger fails the boundary lint
// and re-runs c0/skeleton (eight packages resolve, cli -> eventlog is refused).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, copyDir, fail, probe, root, runProbe, tmpDir } from './_lib.mjs';

function tsconfigOptions(file, seen = new Set()) {
  if (seen.has(file)) fail(`tsconfig extends cycle at ${file}`);
  seen.add(file);
  // tsconfig allows comments; strip line comments conservatively.
  const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(raw);
  let base = {};
  if (cfg.extends) {
    const ext = join(file, '..', cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`);
    if (!existsSync(ext)) fail(`${file} extends ${cfg.extends}, which does not exist`);
    base = tsconfigOptions(ext, seen);
  }
  return { ...base, ...(cfg.compilerOptions ?? {}) };
}

await probe('c0/workspace-layout', async () => {
  const opts = tsconfigOptions(join(root, 'tsconfig.json'));
  for (const flag of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
    check(opts[flag] === true, `tsconfig compilerOptions.${flag} is ${JSON.stringify(opts[flag])}, must be true`);
  }

  const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--offline', '--lockfile-only'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  check(install.status === 0, `pnpm install --frozen-lockfile (lockfile-only, offline) failed: ${install.stderr.trim().split('\n')[0]}`);

  const tc = spawnSync('pnpm', ['typecheck'], { cwd: root, encoding: 'utf8', timeout: 180000 });
  check(tc.status === 0, `pnpm typecheck failed: ${(tc.stdout + tc.stderr).trim().split('\n').slice(-1)[0]}`);

  const tmp = tmpDir('layout');
  copyDir(join(root, 'packages'), join(tmp, 'packages'));
  writeFileSync(join(tmp, 'packages/ledger/src/forbidden.ts'), "import '@fw/adapters';\n");
  const lint = spawnSync(process.execPath, [join(root, 'scripts/boundary-lint.mjs'), tmp], { encoding: 'utf8' });
  check(lint.status === 1, `boundary lint exit ${lint.status} for an @fw/ledger -> @fw/adapters import, want 1`);

  check(runProbe('c0/skeleton') === 0, 'c0/skeleton failed (see output above)');
});
