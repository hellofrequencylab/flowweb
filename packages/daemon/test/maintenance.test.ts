// FW-C-008: fw doctor (runDoctor) and fw gc (gcRunDirs), and both through the in-process core client.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createCoreClient } from '../src/local-client.ts';
import { runDoctor } from '../src/runtime/doctor.ts';
import { gcRunDirs, TERMINAL_RUN_STATES } from '../src/runtime/gc.ts';
import { prepareSandbox } from '../src/runtime/sandbox.ts';
import { tempDir } from './git-fixtures.ts';

const CONTROLS = ['env_scrub', 'home_isolation', 'fs_write_confinement', 'egress', 'process_group_kill'];
const LEVELS = ['enforced', 'best_effort', 'absent'];

let tmp: ReturnType<typeof tempDir>;
let fwHome: string;
beforeEach(() => {
  tmp = tempDir();
  fwHome = join(tmp.path, 'fwhome');
});
afterEach(() => tmp.cleanup());

const runDirs = () => (existsSync(join(fwHome, 'runs')) ? readdirSync(join(fwHome, 'runs')).sort() : []);

describe('runDoctor', () => {
  test('grades every control and leaves no run directory behind', async () => {
    const r = await runDoctor(fwHome, { parentEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    expect(r.home).toBe(fwHome);
    for (const c of CONTROLS) expect(LEVELS).toContain(r.sandbox.controls[c as 'egress'].level);
    expect(LEVELS).toContain(r.sandbox.level);
    // Without FW_EGRESS_PROXY nothing restricts egress, and the doctor says so.
    expect(r.sandbox.controls.egress.level).toBe('absent');
    expect(r.sandbox.level).toBe('absent');
    expect(r.sandbox.controls.env_scrub.level).not.toBe('absent');
    expect(runDirs()).toEqual([]);
  }, 30_000);
});

describe('gcRunDirs', () => {
  test('removes terminal and unknown runs, keeps active ones, skips what is not a run directory', () => {
    const statuses: Record<string, string> = {
      run_queued: 'queued',
      run_starting: 'starting',
      run_running: 'running',
      run_paused: 'paused',
      run_validating: 'validating',
    };
    for (const s of TERMINAL_RUN_STATES) statuses[`run_${s}`] = s;
    for (const id of [...Object.keys(statuses), 'run_unknown'])
      prepareSandbox({ fwHome, run_id: id, parentEnv: {} });
    mkdirSync(join(fwHome, 'runs', 'not-a-run'));
    writeFileSync(join(fwHome, 'runs', 'run_file'), 'x');
    // A worktree under $FW_HOME/worktrees is never gc's business.
    mkdirSync(join(fwHome, 'worktrees', 'run_succeeded'), { recursive: true });

    const r = gcRunDirs(fwHome, (id) => statuses[id]);
    expect(r.removed.map((e) => e.run_id).sort()).toEqual(
      [...TERMINAL_RUN_STATES.map((s) => `run_${s}`), 'run_unknown'].sort(),
    );
    expect(r.removed.find((e) => e.run_id === 'run_unknown')?.status).toBeNull();
    expect(r.kept.map((e) => e.run_id).sort()).toEqual(
      ['run_paused', 'run_queued', 'run_running', 'run_starting', 'run_validating'].sort(),
    );
    expect(r.skipped).toEqual([
      { name: 'not-a-run', reason: 'not a run id' },
      { name: 'run_file', reason: 'not a directory' },
    ]);
    expect(runDirs()).toEqual(
      [
        'not-a-run',
        'run_file',
        'run_paused',
        'run_queued',
        'run_running',
        'run_starting',
        'run_validating',
      ].sort(),
    );
    expect(existsSync(join(fwHome, 'worktrees', 'run_succeeded'))).toBe(true);
  });

  test('a database read failure removes nothing', () => {
    prepareSandbox({ fwHome, run_id: 'run_a', parentEnv: {} });
    expect(() =>
      gcRunDirs(fwHome, () => {
        throw new Error('database unreadable');
      }),
    ).toThrow('database unreadable');
    expect(runDirs()).toEqual(['run_a']);
  });

  test('a home without runs/ is an empty report', () => {
    expect(gcRunDirs(fwHome, () => undefined)).toEqual({ home: fwHome, removed: [], kept: [], skipped: [] });
  });
});

describe('core client', () => {
  test('doctor and gc work on a home with no database', async () => {
    const client = createCoreClient({ home: fwHome, repoDir: tmp.path });
    try {
      const d = await client.doctor();
      for (const c of CONTROLS) expect(LEVELS).toContain(d.sandbox.controls[c as 'egress'].level);
      prepareSandbox({ fwHome, run_id: 'run_leftover', parentEnv: {} });
      const g = await client.gc();
      expect(g.removed.map((e) => e.run_id)).toEqual(['run_leftover']);
      expect(runDirs()).toEqual([]);
      expect(existsSync(join(fwHome, 'db'))).toBe(false);
    } finally {
      client.close();
    }
  }, 30_000);
});
