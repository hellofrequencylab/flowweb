// Probe c0/sandbox-selftest (FW-C-008; backlog verify_probe runtime/sandbox-userdir; KICKOFF
// c0/sandbox-selftest).
// Surface: prepareSandbox({ fwHome, run_id, worktreePath?, parentEnv?, credentials? }),
// spawnInSandbox(sb, cmd, args), killProcessGroup(child), sandboxSelfTest(sb) -> { level, controls:
// { env_scrub, home_isolation, fs_write_confinement, egress, process_group_kill: { level, detail } },
// child_env_keys } and removeRunDir(fwHome, run_id), all exported by packages/daemon/src/index.ts.
// The run directory is $FW_HOME/runs/<run>/ with HOME at $FW_HOME/runs/<run>/home (decision 9).
// The CLI surfaces are `fw doctor --json` and `fw gc --json` (FW-C-008 names both).
// Acceptance:
//   - the child environment contains only allowlisted variables (the child prints it; a parent
//     variable and a secret-shaped parent variable are absent; HOME is the run's own home)
//   - the self-test reports each control as enforced, best_effort or absent, and fw doctor shows it
//   - the reported level matches what the probe observes: process-group kill (a grandchild is gone
//     after the group is killed), egress (enforced: a direct connection fails; best_effort: proxy
//     variables set), env scrub (not absent when the child saw only the allowlist)
//   - a run directory is removable by fw gc without touching the worktree branch
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fakeSecret, fixtureProject, freshHome, fwJson, git, requireExport, sleep } from './_lib.mjs';

type Level = 'enforced' | 'best_effort' | 'absent';
type Sb = { run_id: string; runDir: string; homeDir: string; env: Record<string, string> };
type Report = { level: Level; controls: Record<string, { level: Level; detail: string }>; child_env_keys: string[] };
type Child = import('node:child_process').ChildProcess;
const LEVELS = ['enforced', 'best_effort', 'absent'];
const CONTROLS = ['env_scrub', 'home_isolation', 'fs_write_confinement', 'egress', 'process_group_kill'];

const api = async () => ({
  prepareSandbox: (await requireExport('daemon', 'prepareSandbox', 'FW-C-008')) as (o: Record<string, unknown>) => Sb,
  spawnInSandbox: (await requireExport('daemon', 'spawnInSandbox', 'FW-C-008')) as (sb: Sb, c: string, a: string[]) => Child,
  killProcessGroup: (await requireExport('daemon', 'killProcessGroup', 'FW-C-008')) as (c: Child) => boolean,
  sandboxSelfTest: (await requireExport('daemon', 'sandboxSelfTest', 'FW-C-008')) as (sb: Sb) => Promise<Report>,
});

function output(child: Child): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** True when pid is a live process (a zombie waiting to be reaped is not alive). */
function alive(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
}

describe('c0/sandbox-selftest', () => {
  const home = freshHome('sandbox');
  const secret = fakeSecret('github');
  const parentEnv = { ...process.env, FW_PROBE_LEAK: 'should-not-pass', GH_TOKEN: secret };

  test('the child sees only the allowlisted environment and its own HOME', async () => {
    const { prepareSandbox, spawnInSandbox } = await api();
    const sb = prepareSandbox({ fwHome: home, run_id: 'run_probesbx0001', parentEnv });
    expect(sb.homeDir).toBe(join(home, 'runs', 'run_probesbx0001', 'home'));
    const r = await output(spawnInSandbox(sb, process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']));
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as Record<string, string>;
    expect(env.FW_PROBE_LEAK, 'a parent variable leaked').toBeUndefined();
    expect(JSON.stringify(env), 'a secret-shaped parent variable leaked').not.toContain(secret);
    expect(Object.keys(env).sort(), 'the child env is exactly the sandbox env').toEqual(Object.keys(sb.env).sort());
    expect(env.HOME, 'HOME is the run home').toBe(sb.homeDir);
  });

  test('the self-test grades every control honestly', async () => {
    const { prepareSandbox, spawnInSandbox, killProcessGroup, sandboxSelfTest } = await api();
    const sb = prepareSandbox({ fwHome: home, run_id: 'run_probesbx0002', parentEnv });
    const report = await sandboxSelfTest(sb);
    for (const c of CONTROLS) expect(LEVELS, `control ${c} has a level`).toContain(report.controls[c]?.level);
    expect(LEVELS).toContain(report.level);
    expect(report.child_env_keys.sort(), 'the self-test child saw only the sandbox env').toEqual(Object.keys(sb.env).sort());
    expect(report.controls.env_scrub.level, 'env scrub works, so it is not reported absent').not.toBe('absent');

    // Process-group kill: a grandchild must die with its group when the level claims it does.
    const child = spawnInSandbox(sb, process.execPath, [
      '-e',
      "const g=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(g.pid+'\\n');setInterval(()=>{},1000);",
    ]);
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout?.on('data', (d) => resolve(Number(String(d).trim())));
    });
    killProcessGroup(child);
    await sleep(500);
    const survived = alive(grandchild);
    if (survived) process.kill(grandchild, 'SIGKILL');
    if (report.controls.process_group_kill.level !== 'absent') expect(survived, 'process_group_kill claimed, grandchild survived').toBe(false);

    // Egress: enforced means a direct connection fails; best_effort means proxy variables are set.
    if (report.controls.egress.level === 'best_effort') expect(sb.env.HTTPS_PROXY, 'best_effort egress sets HTTPS_PROXY').toBeTruthy();
    if (report.controls.egress.level === 'enforced') {
      const net = await output(
        spawnInSandbox(sb, process.execPath, [
          '-e',
          "const s=require('node:net').connect(443,'1.1.1.1');s.setTimeout(3000);s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1));",
        ]),
      );
      expect(net.stdout, 'egress reported enforced, but a direct connection went out').not.toContain('CONNECTED');
    }
  }, 60_000);

  test('fw doctor shows the self-test levels', async () => {
    const { prepareSandbox, sandboxSelfTest } = await api();
    const report = await sandboxSelfTest(prepareSandbox({ fwHome: home, run_id: 'run_probesbx0003', parentEnv }));
    const doctor = fwJson(['doctor'], { home });
    expect(doctor.status, `fw doctor --json exits 0 (FW-C-008 names it): ${doctor.stderr ?? ''}`).toBe(0);
    const text = JSON.stringify(doctor.json);
    for (const c of CONTROLS) {
      expect(text, `fw doctor shows control ${c}`).toContain(c);
      expect(text, `fw doctor shows ${c} = ${report.controls[c].level}`).toMatch(
        new RegExp(`"${c}"[^}]*"${report.controls[c].level}"`),
      );
    }
  }, 60_000);

  test('fw gc removes a run directory without touching the worktree branch', async () => {
    const { prepareSandbox } = await api();
    const proj = fixtureProject();
    git(proj.work, 'branch', 'fw/FW-C-901/run_probesbx0004');
    const sb = prepareSandbox({ fwHome: home, run_id: 'run_probesbx0004', parentEnv });
    expect(existsSync(sb.runDir), 'the run directory exists under $FW_HOME/runs').toBe(true);
    const gc = fwJson(['gc'], { home, cwd: proj.work });
    expect(gc.status, 'fw gc --json exits 0 (FW-C-008 names it; removeRunDir exists, the command does not)').toBe(0);
    expect(existsSync(sb.runDir), 'fw gc removed the run directory').toBe(false);
    expect(git(proj.work, 'rev-parse', '--verify', 'fw/FW-C-901/run_probesbx0004'), 'the worktree branch is untouched').toMatch(
      /^[0-9a-f]{40}$/,
    );
  }, 60_000);
});
