// Probe c0/sandbox-selftest (FW-C-008; backlog verify_probe runtime/sandbox-userdir; KICKOFF
// c0/sandbox-selftest).
// Surface: `fw doctor --json`, `fw gc --json`, and runInSandbox(options) exported by
// packages/daemon/src/index.ts:
//   runInSandbox({ home, runId, workdir, cmd, args, env, timeoutS })
//     -> { exit_code, stdout, stderr, controls: { [control]: 'enforced' | 'best_effort' | 'absent' } }
// Acceptance:
//   - the child environment contains only allowlisted variables (the child prints it; a parent
//     variable and a secret-shaped parent variable are absent; HOME is $FW_HOME/sandbox/<run>/home)
//   - the self-test reports each control as enforced, best_effort or absent, and fw doctor shows it
//   - the reported level matches what was enforced: process-group kill (a grandchild is gone after
//     the timeout), egress (enforced: a direct connection fails; best_effort: proxy variables set),
//     os user (enforced: a different uid)
//   - a run directory is removable by fw gc without touching the worktree branch
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fakeSecret, fixtureProject, freshHome, fwJson, git, pidsWithMarker, requireExport, sleep, tmpDir } from './_lib.mjs';

type Level = 'enforced' | 'best_effort' | 'absent';
type Res = { exit_code: number | null; stdout: string; controls: Record<string, Level> };
type Run = (o: Record<string, unknown>) => Promise<Res>;
const LEVELS = ['enforced', 'best_effort', 'absent'];

describe('c0/sandbox-selftest', () => {
  test('scrubbed env, honest levels, process-group kill, fw doctor and fw gc', async () => {
    const runInSandbox = (await requireExport('daemon', 'runInSandbox', 'FW-C-008')) as Run;
    const home = freshHome('sandbox');
    const workdir = tmpDir('sandbox-wd');
    const secret = fakeSecret('github');

    const r = await runInSandbox({
      home,
      runId: 'run_probe0001',
      workdir,
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ env: process.env, uid: process.getuid() }))'],
      env: { ...process.env, FW_PROBE_LEAK: 'should-not-pass', GH_TOKEN: secret },
      timeoutS: 20,
    });
    expect(r.exit_code).toBe(0);
    const child = JSON.parse(r.stdout) as { env: Record<string, string>; uid: number };
    expect(child.env.FW_PROBE_LEAK, 'a parent variable leaked').toBeUndefined();
    expect(JSON.stringify(child.env), 'a secret-shaped parent variable leaked').not.toContain(secret);
    expect(child.env.HOME, 'HOME override').toBe(join(home, 'sandbox', 'run_probe0001', 'home'));
    expect(Object.keys(r.controls).length, 'the self-test reports controls').toBeGreaterThan(0);
    for (const [c, level] of Object.entries(r.controls)) expect(LEVELS, `control ${c}`).toContain(level);

    if (r.controls.os_user === 'enforced') expect(child.uid, 'os_user enforced means another uid').not.toBe(process.getuid!());
    if (r.controls.egress === 'best_effort') expect(child.env.HTTPS_PROXY, 'best_effort egress sets HTTPS_PROXY').toBeTruthy();
    if (r.controls.egress === 'enforced') {
      const net = await runInSandbox({
        home,
        runId: 'run_probe0002',
        workdir,
        cmd: process.execPath,
        args: [
          '-e',
          "const s=require('node:net').connect(443,'1.1.1.1');s.setTimeout(3000);s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1));",
        ],
        env: {},
        timeoutS: 10,
      });
      expect(net.stdout, 'egress reported enforced, but a direct connection went out').not.toContain('CONNECTED');
    }

    const marker = `fw-sandbox-probe-${process.pid}`;
    const killed = await runInSandbox({
      home,
      runId: 'run_probe0003',
      workdir,
      cmd: process.execPath,
      args: [
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},300000)', '${marker}'], { stdio: 'ignore' }); setTimeout(()=>{},300000);`,
      ],
      env: {},
      timeoutS: 1,
    });
    expect(killed.exit_code, 'the timed-out run did not exit 0').not.toBe(0);
    await sleep(500);
    const left = pidsWithMarker(marker);
    for (const p of left) process.kill(p, 'SIGKILL');
    if (killed.controls.process_group_kill === 'enforced') expect(left, 'process_group_kill enforced, grandchild survived').toEqual([]);
    expect(LEVELS).toContain(killed.controls.process_group_kill);

    const doctor = fwJson(['doctor'], { home });
    const text = JSON.stringify(doctor.json);
    for (const [c, level] of Object.entries(r.controls)) {
      expect(text, `fw doctor shows control ${c}`).toContain(c);
      expect(text, `fw doctor shows ${c} = ${level}`).toMatch(new RegExp(`"${c}"[^}]*"${level}"|"${level}"[^}]*"${c}"`));
    }

    const proj = fixtureProject();
    git(proj.work, 'branch', 'row/FW-C-901');
    const runDir = join(home, 'runs', 'run_probe0001');
    expect(existsSync(runDir), 'the run directory exists under $FW_HOME/runs').toBe(true);
    const gc = fwJson(['gc'], { home, cwd: proj.work });
    expect(gc.status).toBe(0);
    expect(existsSync(runDir), 'fw gc removed the run directory').toBe(false);
    expect(git(proj.work, 'rev-parse', '--verify', 'row/FW-C-901'), 'the worktree branch is untouched').toMatch(/^[0-9a-f]{40}$/);
  }, 120_000);
});
