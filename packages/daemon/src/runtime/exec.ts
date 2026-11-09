// Child process helper for the git edge and the runtime. Always argv arrays, never a shell string.
import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(cmd: string, args: readonly string[], res: ExecResult) {
    super(`${cmd} ${args.join(' ')} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
    this.name = 'ExecError';
    this.cmd = cmd;
    this.args = args;
    this.code = res.code;
    this.stdout = res.stdout;
    this.stderr = res.stderr;
  }
}

/** Runs cmd with args (no shell). Resolves with the result whatever the exit code. */
export function execArgv(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Runs cmd and throws ExecError on a nonzero exit. */
export async function execOk(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<string> {
  const res = await execArgv(cmd, args, opts);
  if (res.code !== 0) throw new ExecError(cmd, args, res);
  return res.stdout;
}

/** Environment for git: the given base minus variables that would redirect git to another repository. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0' };
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
  ]) {
    delete env[k];
  }
  return env;
}

/** Runs git in cwd and returns trimmed stdout; throws ExecError on failure. */
export async function git(cwd: string, args: readonly string[], opts: Omit<ExecOptions, 'cwd'> = {}) {
  const out = await execOk('git', args, { ...opts, cwd, env: gitEnv(opts.env) });
  return out.replace(/\n$/, '');
}
