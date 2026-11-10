// FW-C-008: minimal `userdir` sandbox. A per-run directory under $FW_HOME/runs/<run_id> with its own HOME and
// TMPDIR, an environment built from an allowlist (parent environment never inherited), credentials passed in
// explicitly, egress settings from FW_EGRESS_ALLOW, process-group spawn and kill, and a self-test that
// reports each control as enforced, best_effort or absent based only on what a real child process showed.
// The userdir sandbox protects against mistakes and prompt injection, not against a determined attacker.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execArgv } from './exec.ts';
import { assertRunId, runScopedPath } from './paths.ts';

export type ControlLevel = 'enforced' | 'best_effort' | 'absent';
export type ControlName =
  | 'env_scrub'
  | 'home_isolation'
  | 'fs_write_confinement'
  | 'egress'
  | 'process_group_kill';
export type SandboxMode = 'userdir' | 'container';

/** Variables copied from the parent when present. Everything else is dropped. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'NO_COLOR',
]);

/** Keys the sandbox sets itself; an injected credential may not override them. */
const CONTROLLED_KEYS = new Set([
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'FW_RUN_ID',
  'PATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  '__CF_USER_TEXT_ENCODING',
]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_RE = /^\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/;
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

export interface SandboxSettings {
  mode: SandboxMode;
  egressAllow: string[];
  egressProxy: string | null;
  sandboxUser: string | null;
}

/** Splits a comma separated host list and drops anything that is not a host[:port]. */
export function parseEgressAllow(value: string | undefined): string[] {
  if (!value) return [];
  const hosts = value.split(',').map((h) => h.trim());
  return [...new Set(hosts.filter((h) => h.length > 0 && HOST_RE.test(h)))];
}

/** FW_SANDBOX, FW_EGRESS_ALLOW, FW_EGRESS_PROXY and FW_SANDBOX_USER from the daemon environment. */
export function sandboxSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxSettings {
  return {
    mode: env.FW_SANDBOX === 'container' ? 'container' : 'userdir',
    egressAllow: parseEgressAllow(env.FW_EGRESS_ALLOW),
    egressProxy: env.FW_EGRESS_PROXY ? env.FW_EGRESS_PROXY : null,
    sandboxUser: env.FW_SANDBOX_USER ? env.FW_SANDBOX_USER : null,
  };
}

export interface BuildEnvInput {
  parentEnv: NodeJS.ProcessEnv;
  allowlist?: readonly string[];
  credentials?: Readonly<Record<string, string>>;
  home: string;
  tmp: string;
  runId: string;
  egressProxy?: string | null;
  /** Defaults to process.platform; tests pass 'darwin' to check the macOS branch anywhere. */
  platform?: NodeJS.Platform;
}

const CF_TEXT_ENCODING = '__CF_USER_TEXT_ENCODING';

/** Builds the child environment from scratch. Throws when a credential key is malformed or reserved. */
export function buildSandboxEnv(input: BuildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of input.allowlist ?? DEFAULT_ENV_ALLOWLIST) {
    const v = input.parentEnv[k];
    if (typeof v === 'string' && !CONTROLLED_KEYS.has(k)) env[k] = v;
  }
  const parentPath = input.parentEnv.PATH;
  env.PATH = typeof parentPath === 'string' && parentPath.length > 0 ? parentPath : DEFAULT_PATH;
  env.HOME = input.home;
  env.TMPDIR = input.tmp;
  env.TMP = input.tmp;
  env.TEMP = input.tmp;
  env.XDG_CONFIG_HOME = join(input.home, '.config');
  env.XDG_CACHE_HOME = join(input.home, '.cache');
  env.XDG_DATA_HOME = join(input.home, '.local', 'share');
  env.FW_RUN_ID = input.runId;
  // macOS CoreFoundation adds __CF_USER_TEXT_ENCODING (the user id and text encoding, no secret) to
  // any child started without it, so the sandbox sets it itself and the child env stays exactly this.
  if ((input.platform ?? process.platform) === 'darwin') {
    const cf = input.parentEnv[CF_TEXT_ENCODING];
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    env[CF_TEXT_ENCODING] =
      typeof cf === 'string' && cf.length > 0 ? cf : `0x${uid.toString(16).toUpperCase()}:0x0:0x0`;
  }
  if (input.egressProxy) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
      env[k] = input.egressProxy;
    }
    env.NO_PROXY = LOOPBACK_NO_PROXY;
    env.no_proxy = LOOPBACK_NO_PROXY;
  }
  for (const [k, v] of Object.entries(input.credentials ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`invalid credential variable name: ${JSON.stringify(k)}`);
    if (CONTROLLED_KEYS.has(k)) throw new Error(`credential may not override ${k}`);
    if (typeof v !== 'string') throw new Error(`credential ${k} must be a string`);
    env[k] = v;
  }
  return env;
}

export interface Sandbox {
  run_id: string;
  mode: SandboxMode;
  runDir: string;
  homeDir: string;
  tmpDir: string;
  /** Working directory for the vendor process: the run worktree, or the run dir when none was given. */
  cwd: string;
  env: Record<string, string>;
  /** Names of injected credential variables (never their values). */
  credentialKeys: string[];
  egress: { allowlist: string[]; proxy: string | null };
  sandboxUser: string | null;
  files: { stdout: string; stderr: string; result: string; diff: string };
}

export interface PrepareSandboxInput {
  fwHome: string;
  run_id: string;
  worktreePath?: string;
  parentEnv?: NodeJS.ProcessEnv;
  envAllowlist?: readonly string[];
  credentials?: Readonly<Record<string, string>>;
  settings?: Partial<SandboxSettings>;
}

/** Creates $FW_HOME/runs/<run_id>/{home,tmp} (mode 0700) and the scrubbed environment. */
export function prepareSandbox(input: PrepareSandboxInput): Sandbox {
  assertRunId(input.run_id);
  const parentEnv = input.parentEnv ?? process.env;
  const settings: SandboxSettings = { ...sandboxSettingsFromEnv(parentEnv), ...input.settings };
  const runDir = runScopedPath(input.fwHome, 'runs', input.run_id);
  const homeDir = join(runDir, 'home');
  const tmpDir = join(runDir, 'tmp');
  mkdirSync(join(input.fwHome, 'runs'), { recursive: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const env = buildSandboxEnv({
    parentEnv,
    ...(input.envAllowlist !== undefined ? { allowlist: input.envAllowlist } : {}),
    ...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
    home: homeDir,
    tmp: tmpDir,
    runId: input.run_id,
    egressProxy: settings.egressProxy,
  });
  return {
    run_id: input.run_id,
    mode: settings.mode,
    runDir,
    homeDir,
    tmpDir,
    cwd: input.worktreePath ?? runDir,
    env,
    credentialKeys: Object.keys(input.credentials ?? {}),
    egress: { allowlist: [...settings.egressAllow], proxy: settings.egressProxy },
    sandboxUser: settings.sandboxUser,
    files: {
      stdout: join(runDir, 'stdout.log'),
      stderr: join(runDir, 'stderr.log'),
      result: join(runDir, 'result.json'),
      diff: join(runDir, 'diff.patch'),
    },
  };
}

/** Spawns cmd in the sandbox: its cwd, only its env, in a new process group. Never through a shell. */
export function spawnInSandbox(sb: Sandbox, cmd: string, args: readonly string[]): ChildProcess {
  return spawn(cmd, args, { cwd: sb.cwd, env: sb.env, detached: true, shell: false, stdio: 'pipe' });
}

/** Kills the whole process group of a sandboxed child. Returns false when the group was already gone. */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Removes $FW_HOME/runs/<run_id> (fw gc). Never touches worktrees or branches. */
export function removeRunDir(fwHome: string, runId: string): { removed: boolean; path: string } {
  const path = runScopedPath(fwHome, 'runs', runId);
  if (!existsSync(path)) return { removed: false, path };
  rmSync(path, { recursive: true, force: true });
  return { removed: true, path };
}

// ---- Self-test ---------------------------------------------------------------------------------------

export interface ControlResult {
  level: ControlLevel;
  detail: string;
}

export interface SelfTestReport {
  run_id: string;
  mode: SandboxMode;
  platform: NodeJS.Platform;
  /** The weakest level across all controls. */
  level: ControlLevel;
  controls: Record<ControlName, ControlResult>;
  /** Keys the probe child actually saw (values are never reported). */
  child_env_keys: string[];
  /** Plain-language caveats, such as a recorded setting this version does not apply. */
  notes: string[];
  checked_at: string;
}

const RANK: Record<ControlLevel, number> = { absent: 0, best_effort: 1, enforced: 2 };
export function weakestLevel(levels: Iterable<ControlLevel>): ControlLevel {
  let min: ControlLevel = 'enforced';
  for (const l of levels) if (RANK[l] < RANK[min]) min = l;
  return min;
}

// Runs inside the sandbox. Reports what it can see and which writes succeed; prints one JSON line.
const PROBE_SCRIPT = `
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const a = JSON.parse(process.argv[1]);
const tryWrite = (dir) => { const f = path.join(dir, 'fw-sandbox-probe-' + process.pid);
  try { fs.writeFileSync(f, 'x'); fs.rmSync(f, { force: true }); return 'ok'; } catch (e) { return e.code || 'error'; } };
let parentEnv = 'unsupported';
if (process.platform === 'linux') { try { fs.readFileSync('/proc/' + a.parentPid + '/environ'); parentEnv = 'readable'; }
  catch (e) { parentEnv = e.code || 'error'; } }
process.stdout.write(JSON.stringify({ env: process.env, homedir: os.homedir(), tmpdir: os.tmpdir(), cwd: process.cwd(),
  writes: { home: tryWrite(a.home), tmp: tryWrite(a.tmp), outsidePrivate: tryWrite(a.outsidePrivate),
  outsideShared: tryWrite(a.outsideShared) }, parentEnv }));
`;

// Runs inside the sandbox: starts a grandchild that sleeps, prints its pid, then waits.
const GROUP_SCRIPT = `
const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(String(g.pid) + '\\n'); setInterval(() => {}, 1000);
`;

interface ProbeOutput {
  env: Record<string, string>;
  homedir: string;
  tmpdir: string;
  cwd: string;
  writes: { home: string; tmp: string; outsidePrivate: string; outsideShared: string };
  parentEnv: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function checkProcessGroupKill(sb: Sandbox): Promise<ControlResult> {
  const child = spawnInSandbox(sb, process.execPath, ['-e', GROUP_SCRIPT]);
  const grandchild = await new Promise<number | null>((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), 5000);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /^(\d+)\n/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('error', () => resolve(null));
  });
  killProcessGroup(child);
  if (grandchild === null) return { level: 'absent', detail: 'could not start the process-group probe' };
  const deadline = Date.now() + 3000;
  while (isAlive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (isAlive(grandchild)) {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {}
    return { level: 'absent', detail: 'a grandchild survived the process-group kill' };
  }
  return {
    level: 'best_effort',
    detail:
      'killing the process group stopped a grandchild; a process that calls setsid can leave the group, ' +
      'so this is not enforced without cgroups or a PID namespace',
  };
}

function findOnPath(names: readonly string[], pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) if (existsSync(join(dir, n))) return n;
  }
  return null;
}

function containerReport(sb: Sandbox, pathVar: string | undefined): SelfTestReport {
  const runtime = findOnPath(['podman', 'docker'], pathVar);
  const detail = runtime
    ? `FW_SANDBOX=container: ${runtime} is on PATH but container mode is not implemented in C0 (a C1 row), so nothing is applied`
    : 'FW_SANDBOX=container: neither podman nor docker is on PATH';
  const c: ControlResult = { level: 'absent', detail };
  return {
    run_id: sb.run_id,
    mode: 'container',
    platform: process.platform,
    level: 'absent',
    controls: { env_scrub: c, home_isolation: c, fs_write_confinement: c, egress: c, process_group_kill: c },
    child_env_keys: [],
    notes: [],
    checked_at: new Date().toISOString(),
  };
}

/**
 * Spawns probe children inside the sandbox and grades each control by what they observed. Nothing is
 * reported as enforced unless a child showed it. Egress in userdir mode is at most best_effort.
 */
export async function sandboxSelfTest(sb: Sandbox, opts: { now?: () => Date } = {}): Promise<SelfTestReport> {
  if (sb.mode === 'container') return containerReport(sb, process.env.PATH);

  const outsidePrivate = mkdtempSync(join(tmpdir(), 'fw-selftest-'));
  const outsideShared = tmpdir();
  const canaryKey = `FW_SELFTEST_CANARY_${randomBytes(6).toString('hex').toUpperCase()}`;
  let probe: ProbeOutput;
  try {
    const arg = JSON.stringify({
      home: sb.homeDir,
      tmp: sb.tmpDir,
      outsidePrivate,
      outsideShared,
      parentPid: process.pid,
    });
    // The canary is set in the daemon's own environment for the duration of the probe: if the child
    // inherited anything from the parent, it would show up.
    process.env[canaryKey] = '1';
    let res: Awaited<ReturnType<typeof execArgv>>;
    try {
      res = await execArgv(process.execPath, ['-e', PROBE_SCRIPT, arg], {
        cwd: sb.cwd,
        env: sb.env,
        timeoutMs: 15000,
      });
    } finally {
      delete process.env[canaryKey];
    }
    if (res.code !== 0) throw new Error(`sandbox probe exited ${res.code}: ${res.stderr.trim()}`);
    probe = JSON.parse(res.stdout) as ProbeOutput;
  } finally {
    rmSync(outsidePrivate, { recursive: true, force: true });
  }

  const childKeys = Object.keys(probe.env).sort();
  const expected = new Set(Object.keys(sb.env));
  const extra = childKeys.filter((k) => !expected.has(k));
  const missing = [...expected].filter((k) => !(k in probe.env));

  let env_scrub: ControlResult;
  if (extra.length > 0 || missing.length > 0 || canaryKey in probe.env) {
    env_scrub = {
      level: 'absent',
      detail: `child environment differs from the allowlist (extra: ${extra.join(',') || 'none'}; missing: ${missing.join(',') || 'none'})`,
    };
  } else if (probe.parentEnv === 'readable') {
    env_scrub = {
      level: 'best_effort',
      detail:
        `child saw only the ${childKeys.length} allowlisted variables, but it can read the daemon's environment ` +
        'through /proc/<pid>/environ (same OS user); keep secrets out of the daemon environment',
    };
  } else if (probe.parentEnv === 'unsupported') {
    env_scrub = {
      level: 'best_effort',
      detail: `child saw only the ${childKeys.length} allowlisted variables; reading the parent environment by other means was not checked on ${process.platform}`,
    };
  } else {
    env_scrub = {
      level: 'enforced',
      detail: `child saw only the ${childKeys.length} allowlisted variables and could not read the daemon environment (${probe.parentEnv})`,
    };
  }

  const outsideRefused = probe.writes.outsidePrivate !== 'ok' && probe.writes.outsideShared !== 'ok';
  const insideOk = probe.writes.home === 'ok' && probe.writes.tmp === 'ok';

  let home_isolation: ControlResult;
  if (probe.homedir !== sb.homeDir || probe.env.HOME !== sb.homeDir || probe.tmpdir !== sb.tmpDir) {
    home_isolation = { level: 'absent', detail: `child HOME is ${probe.homedir}, not the run home` };
  } else if (outsideRefused) {
    home_isolation = {
      level: 'enforced',
      detail: 'HOME and TMPDIR point into the run dir and outside writes were refused',
    };
  } else {
    home_isolation = {
      level: 'best_effort',
      detail:
        'HOME and TMPDIR point into the run dir, but the Owner home is still reachable by absolute path',
    };
  }

  let fs_write_confinement: ControlResult;
  if (!insideOk) {
    fs_write_confinement = {
      level: 'absent',
      detail: `child could not write its own run dir (home: ${probe.writes.home}, tmp: ${probe.writes.tmp})`,
    };
  } else if (outsideRefused) {
    fs_write_confinement = { level: 'enforced', detail: 'writes outside the run dir were refused by the OS' };
  } else {
    fs_write_confinement = {
      level: 'best_effort',
      detail:
        `cwd, HOME and TMPDIR steer writes into the sandbox, but a write outside it succeeded during the self-test ` +
        `(private dir: ${probe.writes.outsidePrivate}, shared temp: ${probe.writes.outsideShared}); no OS-level isolation`,
    };
  }

  let egress: ControlResult;
  const allow = sb.egress.allowlist.length > 0 ? sb.egress.allowlist.join(',') : 'none';
  if (!sb.egress.proxy) {
    egress = {
      level: 'absent',
      detail: `no egress proxy configured (FW_EGRESS_PROXY); allowlist recorded (${allow}) but not applied, child network is unrestricted`,
    };
  } else if (probe.env.HTTPS_PROXY !== sb.egress.proxy || probe.env.HTTP_PROXY !== sb.egress.proxy) {
    egress = { level: 'absent', detail: 'proxy variables did not reach the child' };
  } else {
    egress = {
      level: 'best_effort',
      detail:
        `HTTPS_PROXY points at ${sb.egress.proxy} (allowlist ${allow}); only clients that honour proxy variables ` +
        'are constrained, and the proxy itself was not tested',
    };
  }

  const process_group_kill = await checkProcessGroupKill(sb);
  const controls = { env_scrub, home_isolation, fs_write_confinement, egress, process_group_kill };
  return {
    run_id: sb.run_id,
    mode: sb.mode,
    platform: process.platform,
    level: weakestLevel(Object.values(controls).map((c) => c.level)),
    controls,
    child_env_keys: childKeys,
    notes: sb.sandboxUser
      ? [
          `FW_SANDBOX_USER=${sb.sandboxUser} is recorded but not applied yet; the run uses the daemon's OS user`,
        ]
      : [],
    checked_at: (opts.now ?? (() => new Date()))().toISOString(),
  };
}
