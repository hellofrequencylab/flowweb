// WS-P0-019: probe executor with timeout, process-group kill and tamper check.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Store, sha256Hex } from '@fw/eventlog';
import { describe, expect, test } from 'vitest';
import {
  checkedProbe,
  executeCommandProbe,
  getDbRow,
  LedgerError,
  OUTPUT_TAIL_BYTES,
  PROBE_MANIFEST,
  type ProbeDefinition,
  parseManifest,
  probeFilesOf,
  retestPremise,
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

describe('probe manifest (probes/MANIFEST.sha256)', () => {
  const PROBE = "console.log('manifest probe ran'); process.exit(1);\n";
  let n = 0;

  /** A store with one synced row whose probe is `node probes/check.mjs`, and a checkout holding that file. */
  function setup(manifest: ((hash: string) => string) | null) {
    n += 1;
    const store = fileStore(dir, `manifest-${n}.sqlite`);
    syncInto(
      store,
      writeRows(join(dir, `manifest-rows-${n}`), [
        row('FW-C-921', { verify_probe: 'node probes/check.mjs' }),
      ]),
    );
    const repo = gitRepo(dir, `manifest-repo-${n}`);
    mkdirSync(join(repo.dir, 'probes'), { recursive: true });
    writeFileSync(join(repo.dir, 'probes/check.mjs'), PROBE);
    if (manifest) writeFileSync(join(repo.dir, PROBE_MANIFEST), manifest(sha256Hex(PROBE)));
    return { store, repo };
  }

  const count = (store: Store, type: string) =>
    store.reader().get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE type = ?', [type])!.n;
  const findings = (store: Store) =>
    store
      .reader()
      .all<{ payload: string }>("SELECT payload FROM events WHERE type = 'audit.finding_raised' ORDER BY seq")
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>);

  test('a probe file that matches its manifest line runs', async () => {
    const { store, repo } = setup((h) => `${h}  probes/check.mjs\n`);
    const r = await runRowProbe(store.writer!, 'FW-C-921', { repoDir: repo.dir, target: 'branch' });
    expect(r.probe).toMatchObject({ status: 'fail', exit_code: 1 });
    expect(r.probe.output_tail).toContain('manifest probe ran');
    expect(count(store, 'ledger.probe_executed')).toBe(1);
    expect(findings(store)).toEqual([]);
    store.close();
  });

  test('a probe file that differs from the manifest is refused with tamper_detected and an audit finding', async () => {
    const { store, repo } = setup((h) => `${h}  probes/check.mjs\n`);
    appendFileSync(join(repo.dir, 'probes/check.mjs'), 'process.exit(0);\n');
    const edited = sha256Hex(readFileSync(join(repo.dir, 'probes/check.mjs')));
    await expect(
      runRowProbe(store.writer!, 'FW-C-921', { repoDir: repo.dir, target: 'branch' }),
    ).rejects.toMatchObject({
      code: 'PROBE_TAMPERED',
      message: expect.stringMatching(/^tamper_detected: probe file probes\/check\.mjs does not match/),
      details: { problem: 'mismatch', probe_file: 'probes/check.mjs', computed_hash: edited },
    });
    expect(count(store, 'ledger.probe_executed')).toBe(0);
    expect(findings(store)).toEqual([
      expect.objectContaining({
        check: 'probe_tamper',
        severity: 'high',
        source: 'auditor',
        ledger_row_id: 'lr_FWC921',
        problem: 'mismatch',
        probe_file: 'probes/check.mjs',
        manifest_hash: sha256Hex(PROBE),
        computed_hash: edited,
      }),
    ]);
    expect(getDbRow(store.reader(), 'FW-C-921').last_probe_status).toBe('never');
    expect(store.verifyChain().ok).toBe(true);
    store.close();
  });

  test('a probe file under probes/ that the manifest does not list is refused', async () => {
    const { store, repo } = setup((h) => `${h}  probes/other.mjs\n`);
    await expect(
      runRowProbe(store.writer!, 'FW-C-921', { repoDir: repo.dir, target: 'branch' }),
    ).rejects.toMatchObject({
      code: 'PROBE_TAMPERED',
      message: expect.stringMatching(/^tamper_detected: probe file probes\/check\.mjs is not listed/),
      details: { problem: 'not_in_manifest', probe_file: 'probes/check.mjs' },
    });
    expect(count(store, 'ledger.probe_executed')).toBe(0);
    expect(findings(store)).toEqual([
      expect.objectContaining({ check: 'probe_tamper', problem: 'not_in_manifest', manifest_hash: null }),
    ]);
    store.close();
  });

  test('a manifest that is not sha256sum output is refused (fail closed)', async () => {
    const { store, repo } = setup(() => 'this is not a manifest\n');
    await expect(
      runRowProbe(store.writer!, 'FW-C-921', { repoDir: repo.dir, target: 'branch' }),
    ).rejects.toMatchObject({ code: 'PROBE_TAMPERED', details: { problem: 'manifest_invalid' } });
    expect(count(store, 'ledger.probe_executed')).toBe(0);
    expect(findings(store)).toEqual([expect.objectContaining({ problem: 'manifest_invalid' })]);
    store.close();
  });

  test('with no manifest only the stored-hash check applies: an edited probe file still runs', async () => {
    const { store, repo } = setup(null);
    appendFileSync(join(repo.dir, 'probes/check.mjs'), '// edited\n');
    const r = await runRowProbe(store.writer!, 'FW-C-921', { repoDir: repo.dir, target: 'branch' });
    expect(r.probe.output_tail).toContain('manifest probe ran');
    expect(count(store, 'ledger.probe_executed')).toBe(1);
    expect(findings(store)).toEqual([]);
    store.close();
  });

  test('the premise re-test goes through the same check (fw ledger retest)', async () => {
    const { store, repo } = setup((h) => `${h}  probes/check.mjs\n`);
    appendFileSync(join(repo.dir, 'probes/check.mjs'), '// edited\n');
    await expect(retestPremise(store.writer!, 'FW-C-921', { repoDir: repo.dir })).rejects.toMatchObject({
      code: 'PROBE_TAMPERED',
      details: { problem: 'mismatch' },
    });
    expect(count(store, 'ledger.probe_executed')).toBe(0);
    expect(getDbRow(store.reader(), 'FW-C-921').status).toBe('open');
    store.close();
  });

  test('sha256sum format: two spaces or a binary marker, ./ prefixes; anything else or a conflicting line is invalid', () => {
    const h = 'a'.repeat(64);
    const H = 'B'.repeat(64);
    expect(parseManifest(`${h}  probes/a.mjs\n${H} *./probes/b.sh\n\n`)).toEqual(
      new Map([
        ['probes/a.mjs', h],
        ['probes/b.sh', 'b'.repeat(64)],
      ]),
    );
    expect(parseManifest(`${h} probes/a.mjs\n`)).toBeUndefined();
    expect(parseManifest(`${h.slice(1)}  probes/a.mjs\n`)).toBeUndefined();
    expect(parseManifest(`${h}  probes/a.mjs\n${'c'.repeat(64)}  probes/a.mjs\n`)).toBeUndefined();
  });

  test('the probe file of `pnpm probe <name>` is the one the runner would run', () => {
    const repo = gitRepo(dir, 'manifest-names');
    mkdirSync(join(repo.dir, 'probes/kernel'), { recursive: true });
    writeFileSync(join(repo.dir, 'probes/kernel/x.sh'), 'exit 1\n');
    writeFileSync(join(repo.dir, 'probes/kernel/x.test.ts'), '');
    const cmd = (argv: string[]) => ({ ...probe(argv), command: { argv, cwd: '.', timeout_s: 30 } });
    expect(probeFilesOf(cmd(['pnpm', 'probe', 'kernel/x']), repo.dir)).toEqual(['probes/kernel/x.sh']);
    expect(probeFilesOf(cmd(['node', 'scripts/probe.mjs', 'kernel/x']), repo.dir)).toEqual([
      'probes/kernel/x.sh',
    ]);
    expect(probeFilesOf(cmd(['sh', 'check.sh']), repo.dir)).toEqual(['check.sh']);
    expect(probeFilesOf(cmd(['pnpm', 'probe', 'kernel/missing']), repo.dir)).toEqual([]);
  });
});
