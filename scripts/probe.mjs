#!/usr/bin/env node
// pnpm probe <path>: runs probes/<path>.{mjs,sh,py,test.ts}. Exit code is the probe's verdict.
// Probes are Tier 0: this runner only locates and executes them; it never edits or skips one.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = process.argv[2];
if (!arg) {
  console.error('usage: pnpm probe <path>   e.g. pnpm probe c0/skeleton');
  process.exit(2);
}
const base = join(root, 'probes', arg.replace(/\.(mjs|sh|py|test\.ts)$/, ''));
const candidates = [
  [`${base}.mjs`, process.execPath, []],
  [`${base}.sh`, 'bash', []],
  [`${base}.py`, 'python3', ['-I']],
  [
    `${base}.test.ts`,
    join(root, 'node_modules/.bin/vitest'),
    ['run', '--config', join(root, 'probes/vitest.config.ts')],
  ],
];
for (const [file, cmd, pre] of candidates) {
  if (!existsSync(file)) continue;
  const started = Date.now();
  const r = spawnSync(cmd, [...pre, file, ...process.argv.slice(3)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FW_REPO_ROOT: root },
  });
  const code = r.status ?? 1;
  console.log(`probe ${arg}: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code}, ${Date.now() - started} ms)`);
  process.exit(code);
}
console.error(`probe ${arg}: not found under probes/ (looked for .mjs, .sh, .py, .test.ts)`);
process.exit(2);
