import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { git } from '../src/runtime/exec.ts';
import { UnsafePathError } from '../src/runtime/paths.ts';
import {
  buildSandboxEnv,
  killProcessGroup,
  parseEgressAllow,
  prepareSandbox,
  removeRunDir,
  sandboxSelfTest,
  sandboxSettingsFromEnv,
  spawnInSandbox,
  weakestLevel,
} from '../src/runtime/sandbox.ts';
import { WorktreeManager } from '../src/runtime/worktrees.ts';
import { commitAll, initRepo, tempDir, writeFile } from './git-fixtures.ts';

let tmp: ReturnType<typeof tempDir>;
let fwHome: string;
const parentEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GH_TOKEN: 'fake-parent-token',
  AWS_SECRET_ACCESS_KEY: 'fake-aws',
  NODE_OPTIONS: '--require /tmp/evil.js',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  FW_EGRESS_ALLOW: 'api.example.invalid, git.example.invalid ,bad host!,',
};

beforeEach(() => {
  tmp = tempDir();
  fwHome = join(tmp.path, 'fwhome');
});
afterEach(() => tmp.cleanup());

describe('environment', () => {
  test('only allowlisted variables plus injected credentials reach the env', () => {
    const env = buildSandboxEnv({
      parentEnv,
      credentials: { VENDOR_API_KEY: 'fake-injected' },
      home: '/h',
      tmp: '/t',
      runId: 'run_a',
      platform: 'linux',
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        'FW_RUN_ID',
        'HOME',
        'LANG',
        'PATH',
        'TEMP',
        'TMP',
        'TMPDIR',
        'VENDOR_API_KEY',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
      ].sort(),
    );
    expect(env.HOME).toBe('/h');
    expect(env.VENDOR_API_KEY).toBe('fake-injected');
  });

  test('on macOS the sandbox sets __CF_USER_TEXT_ENCODING itself, so CoreFoundation adds nothing', () => {
    const base = { home: '/h', tmp: '/t', runId: 'run_a', platform: 'darwin' as const };
    const kept = buildSandboxEnv({
      ...base,
      parentEnv: { ...parentEnv, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' },
    });
    expect(kept.__CF_USER_TEXT_ENCODING).toBe('0x1F5:0x0:0x0');
    const made = buildSandboxEnv({ ...base, parentEnv });
    expect(made.__CF_USER_TEXT_ENCODING).toMatch(/^0x[0-9A-F]+:0x0:0x0$/);
    expect(() =>
      buildSandboxEnv({ ...base, parentEnv, credentials: { __CF_USER_TEXT_ENCODING: 'x' } }),
    ).toThrow(/override/);
    expect(
      buildSandboxEnv({ ...base, parentEnv, platform: 'linux' }).__CF_USER_TEXT_ENCODING,
    ).toBeUndefined();
  });

  test('credentials cannot override controlled keys or use odd names', () => {
    const base = { parentEnv, home: '/h', tmp: '/t', runId: 'run_a' };
    expect(() => buildSandboxEnv({ ...base, credentials: { HOME: '/' } })).toThrow(/override/);
    expect(() => buildSandboxEnv({ ...base, credentials: { NODE_OPTIONS: 'x' } })).toThrow(/override/);
    expect(() => buildSandboxEnv({ ...base, credentials: { 'A=B': 'x' } })).toThrow(/invalid/);
    // A controlled key in the allowlist is still not copied from the parent.
    expect(buildSandboxEnv({ ...base, allowlist: ['NODE_OPTIONS', 'PATH'] }).NODE_OPTIONS).toBeUndefined();
  });

  test('settings come from FW_* variables; bad hosts are dropped', () => {
    expect(parseEgressAllow(parentEnv.FW_EGRESS_ALLOW)).toEqual([
      'api.example.invalid',
      'git.example.invalid',
    ]);
    expect(
      sandboxSettingsFromEnv({ FW_SANDBOX: 'container', FW_EGRESS_PROXY: 'http://127.0.0.1:3128' }),
    ).toEqual({
      mode: 'container',
      egressAllow: [],
      egressProxy: 'http://127.0.0.1:3128',
      sandboxUser: null,
    });
    expect(sandboxSettingsFromEnv({}).mode).toBe('userdir');
  });
});

describe('prepareSandbox and the run dir', () => {
  test('creates runs/<run_id>/{home,tmp}; refuses ids that escape', () => {
    const sb = prepareSandbox({ fwHome, run_id: 'run_a', parentEnv });
    expect(sb.runDir).toBe(join(fwHome, 'runs', 'run_a'));
    expect(existsSync(sb.homeDir) && existsSync(sb.tmpDir)).toBe(true);
    expect(sb.egress).toEqual({ allowlist: ['api.example.invalid', 'git.example.invalid'], proxy: null });
    expect(sb.cwd).toBe(sb.runDir);
    expect(() => prepareSandbox({ fwHome, run_id: '../../etc', parentEnv })).toThrow(UnsafePathError);
    expect(() => removeRunDir(fwHome, 'run_../x')).toThrow(UnsafePathError);
  });

  test('fw gc can remove a run dir without touching the worktree branch', async () => {
    const { repo } = await initRepo(join(tmp.path, 'repo'));
    const mgr = new WorktreeManager({ fwHome, repoPath: repo });
    const wt = await mgr.create({ run_id: 'run_a', row_id: 'R-1', base_ref: 'main' });
    if (!wt.ok) throw new Error(wt.reason);
    writeFile(wt.path, 'x.txt', 'x');
    const head = await commitAll(wt.path, 'work');
    const sb = prepareSandbox({ fwHome, run_id: 'run_a', worktreePath: wt.path, parentEnv });
    writeFileSync(sb.files.stdout, 'output');
    expect(removeRunDir(fwHome, 'run_a')).toEqual({ removed: true, path: sb.runDir });
    expect(existsSync(sb.runDir)).toBe(false);
    expect(await git(repo, ['rev-parse', wt.branch])).toBe(head);
    expect(existsSync(join(wt.path, 'x.txt'))).toBe(true);
    expect(removeRunDir(fwHome, 'run_a').removed).toBe(false);
  });
});

describe('sandboxSelfTest', () => {
  test('a real child sees only the allowlisted environment; levels are honest', async () => {
    const sb = prepareSandbox({
      fwHome,
      run_id: 'run_a',
      parentEnv,
      credentials: { VENDOR_API_KEY: 'fake' },
    });
    const report = await sandboxSelfTest(sb);
    // The acceptance asks the test to print the child environment keys.
    console.log('sandbox self-test:', JSON.stringify(report, null, 2));
    expect(report.child_env_keys).toEqual(Object.keys(sb.env).sort());
    for (const leaked of [
      'GH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NODE_OPTIONS',
      'SSH_AUTH_SOCK',
      'FW_EGRESS_ALLOW',
    ]) {
      expect(report.child_env_keys).not.toContain(leaked);
    }
    expect(report.controls.env_scrub.level).not.toBe('absent');
    expect(report.controls.home_isolation.level).not.toBe('absent');
    // No proxy configured: egress must never be claimed.
    expect(report.controls.egress.level).toBe('absent');
    expect(report.controls.egress.detail).toContain('api.example.invalid');
    // Without OS-level isolation, a write outside the sandbox works, so this cannot be enforced.
    expect(report.controls.fs_write_confinement.level).toBe('best_effort');
    expect(report.controls.process_group_kill.level).toBe('best_effort');
    expect(report.level).toBe('absent');
    expect(Object.values(report.controls).some((c) => c.level === 'enforced' && !c.detail)).toBe(false);
  });

  test('with a proxy configured egress is best_effort, never enforced', async () => {
    const sb = prepareSandbox({
      fwHome,
      run_id: 'run_b',
      parentEnv,
      settings: { egressProxy: 'http://127.0.0.1:3128', sandboxUser: 'fwsandbox' },
    });
    expect(sb.env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
    expect(sb.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    const report = await sandboxSelfTest(sb);
    expect(report.controls.egress.level).toBe('best_effort');
    expect(report.notes[0]).toContain('FW_SANDBOX_USER');
  });

  test('container mode is a stub that reports absent', async () => {
    const sb = prepareSandbox({ fwHome, run_id: 'run_c', parentEnv, settings: { mode: 'container' } });
    const report = await sandboxSelfTest(sb);
    expect(report.mode).toBe('container');
    expect(report.level).toBe('absent');
    for (const c of Object.values(report.controls)) expect(c.level).toBe('absent');
  });
});

test('spawnInSandbox runs in the worktree with the sandbox env, and killProcessGroup stops it', async () => {
  const sb = prepareSandbox({ fwHome, run_id: 'run_k', parentEnv });
  const child = spawnInSandbox(sb, process.execPath, [
    '-e',
    'process.stdout.write(process.cwd() + "|" + process.env.HOME + "|" + (process.env.GH_TOKEN ?? "none")); setInterval(() => {}, 1000)',
  ]);
  const out = await new Promise<string>((resolve) =>
    child.stdout?.once('data', (d: Buffer) => resolve(d.toString())),
  );
  expect(out).toBe(`${sb.cwd}|${sb.homeDir}|none`);
  const exited = new Promise((resolve) => child.once('exit', (_c, sig) => resolve(sig)));
  expect(killProcessGroup(child)).toBe(true);
  expect(await exited).toBe('SIGKILL');
});

test('weakestLevel', () => {
  expect(weakestLevel(['enforced', 'best_effort'])).toBe('best_effort');
  expect(weakestLevel(['enforced'])).toBe('enforced');
  expect(weakestLevel(['enforced', 'absent', 'best_effort'])).toBe('absent');
});
