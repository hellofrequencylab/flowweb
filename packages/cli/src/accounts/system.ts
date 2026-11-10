// What `fw accounts` needs from the machine (run a command, call HTTPS, ask a question, read or
// store a handle), behind one interface so tests can replace it. Handles are kept where the daemon looks for them (packages/daemon/src/creds): the OS keychain
// under service "flowweb", account = handle (macOS `security`, Linux `secret-tool`), else a 0600
// file $FW_HOME/creds/<handle>. A secret is passed on stdin, never in argv.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const KEYCHAIN_SERVICE = 'flowweb';
/** Every vendor token and key we store is made of these characters (checked before storing). */
export const SECRET_SHAPE = /^[A-Za-z0-9._-]{20,512}$/;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start (ENOENT: not installed) or timed out. */
  error?: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  /** Hand the terminal to the command (for `claude setup-token`, `codex login`). */
  interactive?: boolean;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number | null;
  error?: string;
}

export interface System {
  home: string;
  env: NodeJS.ProcessEnv;
  run(cmd: string, args: string[], opts?: RunOptions): RunResult;
  get(url: string, headers: Record<string, string>): Promise<HttpResult>;
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  getSecret(handle: string): { value: string; where: 'keychain' | 'file' } | null;
  setSecret(handle: string, value: string): 'keychain' | 'file';
  writeReport(name: string, body: unknown): string;
  tempDir(): string;
}

function keychainTool(platform: NodeJS.Platform, run: System['run']): 'security' | 'secret-tool' | null {
  if (platform === 'darwin') return run('security', ['help']).error ? null : 'security';
  if (platform === 'linux') return run('secret-tool', ['--version']).error ? null : 'secret-tool';
  return null;
}

export function processSystem(home: string, env: NodeJS.ProcessEnv = process.env): System {
  const run: System['run'] = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, {
      env: opts.env ?? env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      stdio: opts.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const error = r.error ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message) : undefined;
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(error ? { error } : {}) };
  };
  let tool: ReturnType<typeof keychainTool> | undefined;
  const kc = () => {
    tool ??= keychainTool(process.platform, run);
    return tool;
  };
  const credFile = (handle: string) => join(home, 'creds', handle);
  return {
    home,
    env,
    run,
    async get(url, headers) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
        await res.body?.cancel();
        return { status: res.status };
      } catch (e) {
        return { status: null, error: (e as Error).message };
      }
    },
    ask(question, opts = {}) {
      return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let muted = false;
        if (opts.hidden) {
          const w = rl as unknown as { _writeToOutput: (s: string) => void };
          w._writeToOutput = (s) => {
            if (!muted) process.stdout.write(s);
          };
        }
        rl.question(question, (answer) => {
          if (opts.hidden) process.stdout.write('\n');
          rl.close();
          resolve(answer.trim());
        });
        muted = true;
      });
    },
    getSecret(handle) {
      const t = kc();
      if (t) {
        const r =
          t === 'security'
            ? run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', handle, '-w'])
            : run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'handle', handle]);
        const v = r.stdout.replace(/\r?\n$/, '');
        if (r.code === 0 && v) return { value: v, where: 'keychain' };
      }
      const f = credFile(handle);
      if (!existsSync(f) || !lstatSync(f).isFile()) return null;
      const v = readFileSync(f, 'utf8').replace(/\r?\n$/, '');
      return v ? { value: v, where: 'file' } : null;
    },
    setSecret(handle, value) {
      if (!SECRET_SHAPE.test(value)) throw new Error('that does not look like a token or key');
      const t = kc();
      if (t === 'security') {
        // `security -i` reads its command from stdin, so the secret never shows in `ps`.
        const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${handle} -l "FlowWeb ${handle}" -w ${value}\n`;
        const r = run('security', ['-i'], { input: line });
        // Read it back: only an exact match counts, otherwise fall through to the file.
        const back = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', handle, '-w']);
        if (r.code === 0 && back.code === 0 && back.stdout.replace(/\r?\n$/, '') === value) return 'keychain';
      } else if (t === 'secret-tool') {
        const r = run(
          'secret-tool',
          ['store', `--label=FlowWeb ${handle}`, 'service', KEYCHAIN_SERVICE, 'handle', handle],
          { input: value },
        );
        if (r.code === 0) return 'keychain';
      }
      mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
      writeFileSync(credFile(handle), `${value}\n`, { mode: 0o600 });
      chmodSync(credFile(handle), 0o600);
      return 'file';
    },
    writeReport(name, body) {
      mkdirSync(home, { recursive: true });
      const p = join(home, name);
      writeFileSync(p, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      return p;
    },
    tempDir() {
      return mkdtempSync(join(tmpdir(), 'fw-accounts-'));
    },
  };
}
