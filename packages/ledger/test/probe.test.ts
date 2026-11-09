// WS-P0-019: probe executor with timeout, process-group kill and tamper check.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkedProbe,
  executeCommandProbe,
  getDbRow,
  LedgerError,
  OUTPUT_TAIL_BYTES,
  type ProbeDefinition,
  runRowProbe,
} from '../src/index.ts';
import { fileStore, gitRepo, rawSql, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();

function probe(argv: string[], timeout_s = 30, exit_code = 0): ProbeDefinition {
  return {
    id: 'prb_test0001',
    version: 1,
    kind: 'command',
    measures: 'The test command exits with the expected code.',
    runs_against: 'merged_artifact',
    command: { argv, cwd: '.', timeout_s },
    expected: { exit_code },
    owner_trust_tier: 0,
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('executeCommandProbe', () => {
  test('exit code, duration and output tail are captured; the expected exit code decides pass', async () => {
    const pass = await executeCommandProbe(probe(['sh', '-c', 'echo hello; echo oops >&2; exit 0']), {
      cwd: dir,
    });
    expect(pass).toMatchObject({ status: 'pass', exit_code: 0, timed_out: false });
    expect(pass.output_tail).toContain('hello');
    expect(pass.output_tail).toContain('oops');
    expect(pass.duration_ms).toBeGreaterThanOrEqual(0);
    const fail = await executeCommandProbe(probe(['sh', '-c', 'exit 3']), { cwd: dir });
    expect(fail).toMatchObject({ status: 'fail', exit_code: 3 });
    const expected3 = await executeCommandProbe(probe(['sh', '-c', 'exit 3'], 30, 3), { cwd: dir });
    expect(expected3.status).toBe('pass');
  });

  test('only the last 4 KB of output is kept, and secrets in it are redacted', async () => {
    const r = await executeCommandProbe(
      probe([
        'sh',
        '-c',
        'i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; echo token ghp_abcdefghijklmnop1234',
      ]),
      { cwd: dir },
    );
    expect(Buffer.byteLength(r.output_tail)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(r.output_tail).toContain('line-1999');
    expect(r.output_tail).not.toContain('line-0\n');
    expect(r.output_tail).not.toContain('ghp_abcdefghijklmnop1234');
    expect(r.output_tail).toContain('[REDACTED]');
  });

  test('the probe does not inherit secret environment variables', async () => {
    process.env.FW_TEST_SECRET_TOKEN = 'do-not-leak';
    try {
      const r = await executeCommandProbe(probe(['sh', '-c', 'echo "[$FW_TEST_SECRET_TOKEN]"']), {
        cwd: dir,
      });
      expect(r.output_tail).toContain('[]');
    } finally {
      delete process.env.FW_TEST_SECRET_TOKEN;
    }
  });

  test('a probe exceeding its timeout is killed with its whole process group and recorded as fail', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const t0 = Date.now();
    const r = await executeCommandProbe(
      probe(['sh', '-c', `sleep 60 & echo $! > ${pidFile}; trap '' TERM; wait`], 1),
      { cwd: dir },
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r).toMatchObject({ status: 'fail', timed_out: true });
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(grandchild)).toBe(false);
  });

  test('a command that cannot start is an error, not a pass or a crash', async () => {
    const r = await executeCommandProbe(probe(['/nonexistent/fw-probe-binary']), { cwd: dir });
    expect(r.status).toBe('error');
    expect(r.error).toBeDefined();
  });

  test('a probe cwd outside the checkout is refused', () => {
    const p = probe(['true']);
    p.command!.cwd = '../..';
    expect(() => executeCommandProbe(p, { cwd: dir })).toThrow(/leaves the checkout/);
  });
});

describe('tamper check', () => {
  test('a stored probe changed behind the store is refused with tamper_detected and an audit finding', async () => {
    const path = join(dir, 'tamper.sqlite');
    let store = fileStore(dir, 'tamper.sqlite');
    syncInto(store, writeRows(join(dir, 'tamper-rows'), [row('FW-C-920')]));
    const good = getDbRow(store.reader(), 'FW-C-920');
    expect(checkedProbe(store.writer!, good).command?.argv).toEqual(['sh', 'check.sh']);
    store.close();
    // The probe-immutable trigger blocks this through the store; simulate an out-of-band edit.
    rawSql(
      path,
      `DROP TRIGGER trg_ledger_probe_immutable;
       UPDATE ledger_rows SET probe_spec = replace(probe_spec, 'check.sh', 'evil.sh') WHERE id = 'lr_FWC920';`,
    );
    store = fileStore(dir, 'tamper.sqlite');
    const repo = gitRepo(dir, 'tamper-repo');
    await expect(
      runRowProbe(store.writer!, 'FW-C-920', { repoDir: repo.dir, target: 'branch' }),
    ).rejects.toMatchObject({
      code: 'PROBE_TAMPERED',
      message: expect.stringMatching(/tamper_detected/),
    });
    const finding = store
      .reader()
      .get<{ payload: string }>("SELECT payload FROM events WHERE type = 'audit.finding_raised'");
    expect(JSON.parse(finding!.payload)).toMatchObject({ check: 'probe_tamper', ledger_row_id: 'lr_FWC920' });
    expect(
      store.reader().get("SELECT COUNT(*) AS n FROM events WHERE type = 'ledger.probe_executed'"),
    ).toEqual({ n: 0 });
    store.close();
  });

  test('LedgerError carries a code', () => {
    expect(new LedgerError('NOT_FOUND', 'x').code).toBe('NOT_FOUND');
  });
});
