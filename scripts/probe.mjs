#!/usr/bin/env node
// pnpm probe <path>: runs probes/<path>.{mjs,sh,py,test.ts}. Exit code is the probe's verdict.
// Probes are Tier 0: this runner only locates and executes them; it never edits or skips one.
//
// Every run is time-limited: 60 s by default. A probe that needs longer says so in its first
// lines with a `probe-timeout-s: <seconds>` comment (at most 1800). FW_PROBE_TIMEOUT_S overrides
// the limit for this one run and is not passed down, so a probe that runs other probes gets their
// own limits. On timeout the probe's whole process group is stopped (SIGTERM, then SIGKILL after
// 2 s), the runner says so, and the exit is 124.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 1800;
const KILL_GRACE_MS = 2000;

const root = resolve(import.meta.dirname, '..');
const arg = process.argv[2];
if (!arg) {
  console.error('usage: pnpm probe <path>   e.g. pnpm probe c0/skeleton');
  process.exit(2);
}

/** The limit declared in the probe file's header, if any. */
function declaredTimeout(file) {
  const head = readFileSync(file, 'utf8').split('\n').slice(0, 20).join('\n');
  const m = head.match(/probe-timeout-s:\s*(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function limitSeconds(file) {
  const fromEnv = process.env.FW_PROBE_TIMEOUT_S;
  const raw =
    fromEnv !== undefined && fromEnv !== '' ? Number(fromEnv) : (declaredTimeout(file) ?? DEFAULT_TIMEOUT_S);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_TIMEOUT_S) {
    console.error(`probe ${arg}: invalid time limit ${raw} (want 1..${MAX_TIMEOUT_S} seconds)`);
    process.exit(2);
  }
  return raw;
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
const found = candidates.find(([file]) => existsSync(file));
if (!found) {
  console.error(`probe ${arg}: not found under probes/ (looked for .mjs, .sh, .py, .test.ts)`);
  process.exit(2);
}

const [file, cmd, pre] = found;
const limit = limitSeconds(file);
const env = { ...process.env, FW_REPO_ROOT: root };
delete env.FW_PROBE_TIMEOUT_S;
const started = Date.now();
// detached: the probe leads its own process group, so a timeout stops everything it started.
const child = spawn(cmd, [...pre, file, ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
  env,
  detached: true,
});

const killGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {}
};
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`probe ${arg}: timed out after ${limit} s; stopping it and its child processes`);
  killGroup('SIGTERM');
  setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
}, limit * 1000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => killGroup(sig));

child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`probe ${arg}: could not start ${cmd}: ${e.message}`);
  process.exit(1);
});
child.on('exit', (status) => {
  clearTimeout(timer);
  const code = timedOut ? 124 : (status ?? 1);
  // Anything the probe left running in its group goes too, so no run leaks processes.
  killGroup('SIGKILL');
  const verdict = code === 0 ? 'PASS' : timedOut ? 'FAIL, timed out' : 'FAIL';
  console.log(`probe ${arg}: ${verdict} (exit ${code}, ${Date.now() - started} ms)`);
  process.exit(code);
});
