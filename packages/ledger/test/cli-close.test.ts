// The CLI acceptance lines that need a row in verifying (which only the ledger library can produce
// before `fw run start` exists): the state is prepared through the library, then `pnpm fw` runs as
// a separate process, exactly as the Owner would run it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { describe, expect, test } from 'vitest';
import { dbPath, retestPremise, syncRows, transitionRow } from '../src/index.ts';
import { fwHome, gitRepo, PROJECT, REPO_ROOT, row, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();

function fw(home: string, cwd: string, args: string[]) {
  const r = spawnSync('pnpm', ['-s', '--dir', REPO_ROOT, 'fw', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FW_HOME: home },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function verifyingRow(name: string) {
  const home = fwHome(join(dir, name));
  mkdirSync(join(home, 'db'), { recursive: true });
  const repo = gitRepo(dir, `${name}-repo`);
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  syncRows(store.writer!, {
    rowsDir: writeRows(join(dir, `${name}-rows`), [row('FW-C-960')]),
    project: PROJECT,
  });
  await retestPremise(store.writer!, 'FW-C-960', { repoDir: repo.dir });
  for (const to of ['claimed', 'running', 'verifying'] as const) transitionRow(store.writer!, 'FW-C-960', to);
  return { home, repo, store };
}

describe('fw ledger close (process level)', () => {
  test('close on a row without a passing probe exits 1 with the trigger message', async () => {
    const { home, repo, store } = await verifyingRow('cli-fail');
    store.close();
    const r = fw(home, repo.dir, [
      'ledger',
      'close',
      'FW-C-960',
      '--merged-sha',
      repo.base,
      '--repo',
      repo.dir,
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('ledger_rows: done requires last_probe_status=pass');
    const j = fw(home, repo.dir, [
      'ledger',
      'close',
      'FW-C-960',
      '--merged-sha',
      repo.base,
      '--repo',
      repo.dir,
      '--json',
    ]);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out)).toEqual({
      error: expect.objectContaining({
        code: 'REFUSED_BY_DATABASE',
        message: 'ledger_rows: done requires last_probe_status=pass',
      }),
    });
  });

  test('close with a passing probe on the merged commit exits 0 and the row shows done with its evidence', async () => {
    const { home, repo, store } = await verifyingRow('cli-pass');
    store.close();
    writeFileSync(join(repo.dir, 'done.txt'), 'done\n');
    const merged = repo.commit('the work');
    const r = fw(home, repo.dir, ['ledger', 'close', 'FW-C-960', '--merged-sha', merged, '--repo', repo.dir]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`ledger close FW-C-960: done; probe exit 0 in \\d+ ms on ${merged}`));
    const show = JSON.parse(fw(home, repo.dir, ['ledger', 'show', 'FW-C-960', '--json']).out);
    expect(show.row).toMatchObject({ code: 'FW-C-960', status: 'done', merged_sha: merged });
    expect(show.evidence[0]).toMatchObject({ subject_sha: merged, probe: { exit_code: 0 } });
    expect(fw(home, repo.dir, ['audit', 'verify']).code).toBe(0);
  });

  test('a write command exits 4 while another process holds the writer lock', async () => {
    const { home, repo, store } = await verifyingRow('cli-locked');
    try {
      const r = fw(home, repo.dir, ['ledger', 'sync', '--rows', join(dir, 'cli-locked-rows')]);
      expect(r.code).toBe(4);
      expect(r.err).toMatch(/writer lock is held/);
    } finally {
      store.close();
    }
  });
});
