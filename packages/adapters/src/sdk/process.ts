// Shared process runner for vendor CLIs: own process group, scrubbed environment, HOME override,
// group kill (SIGTERM then SIGKILL). The environment is never logged.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { LineSplitter, type RawLine } from './lines.ts';
import type { VendorAdapterInput } from './types.ts';

/** Parent variables a vendor process may inherit. Nothing else from the parent environment passes. */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

/** Discard-port proxy used for deny_all: proxy-respecting clients fail fast. Best effort only. */
export const DENY_ALL_PROXY = 'http://127.0.0.1:9';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface SandboxEnvOptions {
  home: string;
  credentialEnv?: Record<string, string>;
  sandbox?: VendorAdapterInput['sandbox'];
  /** Non-secret variables the adapter itself needs (for example a no-color switch). */
  extra?: Record<string, string>;
  parentEnv?: NodeJS.ProcessEnv;
}

export function buildSandboxEnv(o: SandboxEnvOptions): Record<string, string> {
  const parent = o.parentEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === 'string') env[k] = v;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  env.HOME = o.home;
  env.TMPDIR = o.home;
  env.XDG_CONFIG_HOME = `${o.home}/.config`;
  env.XDG_CACHE_HOME = `${o.home}/.cache`;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  if (o.sandbox) {
    let proxy: string | undefined;
    if (o.sandbox.network_policy === 'deny_all') proxy = DENY_ALL_PROXY;
    else if (o.sandbox.proxy) proxy = o.sandbox.proxy;
    if (proxy) {
      env.HTTPS_PROXY = proxy;
      env.HTTP_PROXY = proxy;
      env.https_proxy = proxy;
      env.http_proxy = proxy;
      env.NO_PROXY = 'localhost,127.0.0.1';
    }
  }
  for (const [k, v] of Object.entries(o.extra ?? {})) env[k] = v;
  for (const [k, v] of Object.entries(o.credentialEnv ?? {})) {
    if (!ENV_NAME.test(k)) throw new Error(`invalid credential variable name: ${k}`);
    env[k] = v;
  }
  return env;
}

/** True while any non-zombie process is in the group. Zombies wait on their reaper and cannot act. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
  if (process.platform !== 'linux') return true;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue;
      }
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(rest[2]) === pgid && rest[0] !== 'Z') return true;
    }
    return false;
  } catch {
    return true;
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: already gone.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the group, wait up to graceMs, then SIGKILL and wait until no live member remains. */
export async function killGroup(pgid: number, graceMs: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return;
    await sleep(25);
  }
  signalGroup(pgid, 'SIGKILL');
  const hard = Date.now() + 5000;
  while (groupAlive(pgid) && Date.now() < hard) {
    signalGroup(pgid, 'SIGKILL');
    await sleep(25);
  }
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  maxLineBytes?: number;
  onStdout: (line: RawLine) => void;
  onStderr: (line: string) => void;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Exit status as an integer: the code, or 128 plus the signal number. */
  exit_code: number;
  spawn_error?: string;
}

export interface GroupProcess {
  pgid: number | null;
  /** Resolves after the leader exits, stdout is drained and no live group member remains. */
  exited: Promise<ProcessExit>;
  kill(graceMs: number): Promise<void>;
}

export function spawnGroup(spec: SpawnSpec): GroupProcess {
  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    const msg = (e as Error).message;
    return {
      pgid: null,
      exited: Promise.resolve({ code: null, signal: null, exit_code: 127, spawn_error: msg }),
      kill: async () => {},
    };
  }
  const pgid = child.pid ?? null;
  const out = new LineSplitter(spec.maxLineBytes);
  const err = new LineSplitter(64 * 1024);
  child.stdout?.on('data', (c: Buffer) => {
    for (const l of out.push(c)) spec.onStdout(l);
  });
  child.stderr?.on('data', (c: Buffer) => {
    for (const l of err.push(c)) if (l.kind === 'line') spec.onStderr(l.text);
  });
  child.stdin?.on('error', () => {});
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  else child.stdin?.end();

  let killing: Promise<void> | null = null;
  const kill = (graceMs: number) => {
    if (pgid === null) return Promise.resolve();
    killing ??= killGroup(pgid, graceMs);
    return killing;
  };

  const exited = new Promise<ProcessExit>((resolve) => {
    let spawnError: string | undefined;
    child.on('error', (e) => {
      spawnError = e.message;
    });
    const closed = new Promise<void>((r) => child.on('close', () => r()));
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      // The leader is gone; make sure nothing it left behind keeps running (or holds our pipes).
      if (pgid !== null) await kill(500);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise<void>((r) => (timer = setTimeout(r, 2000)))]);
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      for (const l of out.end()) spec.onStdout(l);
      for (const l of err.end()) if (l.kind === 'line') spec.onStderr(l.text);
      const sigNum = signal ? (constants.signals[signal] ?? 0) : 0;
      const exit_code = code ?? (signal ? 128 + sigNum : spawnError ? 127 : 1);
      resolve({ code, signal, exit_code, ...(spawnError ? { spawn_error: spawnError } : {}) });
    };
    let done = false;
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      void finish(code, signal);
    });
    child.on('error', () => {
      // Spawn failure (for example ENOENT) emits 'error' and possibly no 'exit'.
      if (done || child.pid !== undefined) return;
      done = true;
      void finish(null, null);
    });
  });

  return { pgid, exited, kill };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

/** Run a short command (preflight, git) with a scrubbed env and a timeout. Never throws. */
export function execCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs?: number; maxBuffer?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs ?? 15000,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code,
          ...(error && typeof error.code !== 'number' ? { error: error.message } : {}),
        });
      },
    );
  });
}
