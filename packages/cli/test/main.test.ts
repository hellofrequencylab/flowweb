// FW-C-006: router, --json, exit codes, help. Runs main() in-process against a fake CoreClient.
import { describe, expect, test } from 'vitest';
import type { CoreClient, CoreClientFactory } from '../src/client.ts';
import { COMMANDS, EXIT, helpText, type Io, main } from '../src/index.ts';

const SHA = 'a'.repeat(40);

function fakeClient(overrides: Partial<CoreClient> = {}): CoreClient {
  const view = {
    code: 'FW-C-001',
    id: 'lr_FWC001',
    title: 'A row',
    status: 'open' as const,
    priority: 'P0',
    size: 'S',
    lane: 'devex',
    wave: 'C0',
    owner: { kind: 'agent', id: 'agt_chiefofstaff' },
    depends_on: [],
    premise_valid: null,
    last_probe_status: 'never',
    last_probe_at: null,
    merged_sha: null,
    evidence_bundle_id: null,
    probe_hash: 'f'.repeat(64),
    closed_at: null,
  };
  const probeEv = { exit_code: 0, output_tail: '', duration_ms: 5 };
  return {
    ledgerSync: async () => ({
      applied: true,
      created: ['FW-C-001'],
      unchanged: [],
      refused: [],
      drifted: [],
      graph: { rows: 1, edges: 0, acyclic: true, cycles: [] },
      project_id: 'prj_x',
    }),
    ledgerList: async () => [view],
    ledgerShow: async () => ({
      row: view,
      contract: {} as never,
      probe: { kind: 'command', command: { argv: ['true'], timeout_s: 1 } } as never,
      evidence: [],
      work_orders: [],
      events: [],
    }),
    ledgerNext: async () => ({ row: null, retest_candidates: 0 }),
    ledgerRetest: async () => ({
      code: 'FW-C-001',
      outcome: 'ready',
      still_valid: true,
      from: 'open',
      to: 'ready',
      result_id: 'prr_x',
      base_sha: SHA,
      probe: { ...probeEv, status: 'fail', timed_out: false },
    }),
    ledgerClose: async () => ({
      code: 'FW-C-001',
      status: 'done',
      merged_sha: SHA,
      bundle_id: 'evb_x',
      bundle_hash: 'b'.repeat(64),
      result_id: 'prr_x',
      probe: probeEv,
    }),
    woIssue: async () => ({
      code: 'FW-C-001',
      work_order_id: 'wo_x',
      version: 1,
      content_hash: 'c'.repeat(64),
      doer: 'agt_w',
      verifier: 'agt_v',
      expires_at: '2026-11-10T00:00:00.000Z',
      work_order: { budget: { caps: { max_usd: 1 } } } as never,
    }),
    auditVerify: async () => ({ ok: true, count: 3, head: 'd'.repeat(64) }),
    close: () => {},
    ...overrides,
  };
}

function run(argv: string[], client: CoreClient = fakeClient()) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t), env: {}, cwd: '/tmp' };
  const factory: CoreClientFactory = () => client;
  return main(argv, io, factory).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

const sampleArgs = (path: string[]) => {
  const c = COMMANDS.find((x) => x.path.join(' ') === path.join(' '))!;
  return [...c.path, ...c.args.map(() => 'FW-C-001'), ...(c.required ?? []).flatMap((o) => [`--${o}`, SHA])];
};

describe('help', () => {
  test('fw --help lists exactly the implemented commands', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(EXIT.OK);
    const listed = r.out
      .split('\n')
      .filter((l) => l.startsWith('  fw '))
      .map((l) => l.trim().split(/\s+/).slice(1, 3).join(' '));
    expect(listed).toEqual(COMMANDS.map((c) => c.path.join(' ')));
    expect(helpText()).toContain('exit codes');
  });

  test('no command is a usage error', async () => {
    expect((await run([])).code).toBe(EXIT.USAGE);
  });
});

describe('usage errors exit 2', () => {
  test.each([
    [['bogus']],
    [['ledger', 'show']],
    [['ledger', 'show', 'a', 'b']],
    [['ledger', 'list', '--merged-sha', SHA]],
    [['ledger', 'close', 'FW-C-001']],
    [['ledger', 'list', '--no-such-flag']],
  ])('%j', async (argv) => {
    const r = await run(argv);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toMatch(/^fw: /);
  });

  test('a bad row code from the core is a usage error', async () => {
    const e = Object.assign(new Error('not a row code'), { code: 'BAD_ARGUMENT' });
    const r = await run(
      ['ledger', 'show', 'nope'],
      fakeClient({ ledgerShow: async () => Promise.reject(e) }),
    );
    expect(r.code).toBe(EXIT.USAGE);
  });
});

describe('--json', () => {
  test.each(COMMANDS.map((c) => [c.path.join(' ')]))('%s prints exactly one JSON document', async (path) => {
    const r = await run([...sampleArgs(path.split(' ')), '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });

  test('an error under --json is one JSON document with code and message', async () => {
    const e = Object.assign(new Error('ledger_rows: done requires last_probe_status=pass'), {
      code: 'REFUSED_BY_DATABASE',
      details: { code: 'FW-C-001' },
    });
    const r = await run(
      ['ledger', 'close', 'FW-C-001', '--merged-sha', SHA, '--json'],
      fakeClient({ ledgerClose: async () => Promise.reject(e) }),
    );
    expect(r.code).toBe(EXIT.FAILED);
    expect(JSON.parse(r.out)).toEqual({
      error: { code: 'REFUSED_BY_DATABASE', message: e.message, details: { code: 'FW-C-001' } },
    });
  });
});

describe('exit codes', () => {
  test('a refused sync exits 1 and prints the id and both hashes', async () => {
    const client = fakeClient({
      ledgerSync: async () => ({
        applied: false,
        created: [],
        unchanged: [],
        refused: [
          {
            code: 'FW-C-005',
            id: 'lr_FWC005',
            reason: 'probe_changed',
            message: 'x',
            stored_hash: '1'.repeat(64),
            file_hash: '2'.repeat(64),
          },
        ],
        drifted: [],
        graph: { rows: 1, edges: 0, acyclic: true, cycles: [] },
        project_id: null,
      }),
    });
    const r = await run(['ledger', 'sync'], client);
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.out).toContain('lr_FWC005');
    expect(r.out).toContain('1'.repeat(64));
    expect(r.out).toContain('2'.repeat(64));
  });

  test('a held writer lock exits 4', async () => {
    const e = Object.assign(new Error('event log writer lock is held by pid 1'), { code: 'LOCKED' });
    const r = await run(['ledger', 'sync'], fakeClient({ ledgerSync: async () => Promise.reject(e) }));
    expect(r.code).toBe(EXIT.LOCKED);
  });

  test('a broken chain exits 1 with one line', async () => {
    const r = await run(
      ['audit', 'verify'],
      fakeClient({ auditVerify: async () => ({ ok: false, seq: 7, reason: 'hash mismatch', count: 6 }) }),
    );
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.out).toBe('audit verify: BROKEN at seq 7: hash mismatch (6 events verified before it)');
  });

  test('an inconclusive premise re-test exits 1', async () => {
    const r = await run(
      ['ledger', 'retest', 'FW-C-001'],
      fakeClient({
        ledgerRetest: async () => ({
          code: 'FW-C-001',
          outcome: 'unchanged',
          still_valid: null,
          from: 'open',
          to: 'open',
          result_id: 'prr_x',
          base_sha: null,
          probe: { exit_code: null, output_tail: '', duration_ms: 1, status: 'fail', timed_out: true },
        }),
      }),
    );
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.out).toMatch(/inconclusive \(timed out\)/);
  });

  test('the client is closed after every command', async () => {
    let closed = 0;
    await run(['ledger', 'list'], fakeClient({ close: () => closed++ }));
    await run(
      ['ledger', 'show', 'X'],
      fakeClient({ ledgerShow: async () => Promise.reject(new Error('x')), close: () => closed++ }),
    );
    expect(closed).toBe(2);
  });
});
