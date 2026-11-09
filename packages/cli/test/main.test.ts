// FW-C-006: router, --json, exit codes, help. Runs main() in-process against a fake CoreClient.
import { describe, expect, test } from 'vitest';
import type { CoreClient, CoreClientFactory } from '../src/client.ts';
import { COMMANDS, EXIT, helpText, type Io, invocationCwd, main } from '../src/index.ts';

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
    runStart: async () => ({
      code: 'FW-C-001',
      ok: true,
      run_id: 'run_x',
      status: 'succeeded',
      failure_class: null,
      reason: null,
      policy_code: null,
      row_status: 'verifying',
      work_order_id: 'wo_x',
      branch: 'fw/FW-C-001/run_x',
      worktree: null,
      pr: { number: 1, url: 'file:///tmp/o.git/pull/1', head_sha: SHA, comment_url: null },
      evidence_bundle_id: 'evb_x',
      bundle_hash: 'b'.repeat(64),
      sandbox_level: 'best_effort',
      cost_usd: 0.01,
      cost_estimated: false,
    }),
    runList: async () => [runSummary],
    runShow: async () => ({
      ...runSummary,
      work_order_id: 'wo_x',
      agent_id: 'agt_w',
      workspace_path: null,
      started_at: null,
      turns: 2,
      tokens_in: 1,
      tokens_out: 1,
      exit_code: 0,
      cost: { usd: null, entries: 0, known: false },
      artifacts: [],
      evidence: [
        { id: 'evb_x', bundle_hash: 'b'.repeat(64), subject_sha: SHA, scan_red: false, created_at: 'now' },
      ],
      steps: 0,
      events: [],
    }),
    spendRollup: async ({ by }) => (by === 'agent' ? spendByAgent : []),
    doctor: async () => doctorReport,
    gc: async () => ({
      home: '/h',
      removed: [{ run_id: 'run_done', path: '/h/runs/run_done', status: 'succeeded' }],
      kept: [{ run_id: 'run_live', path: '/h/runs/run_live', status: 'running' }],
      skipped: [],
    }),
    close: () => {},
    ...overrides,
  };
}

const control = (level: 'enforced' | 'best_effort' | 'absent', detail: string) => ({ level, detail });
const doctorReport = {
  home: '/h',
  sandbox: {
    run_id: 'run_doctor-x',
    mode: 'userdir',
    platform: 'linux',
    level: 'absent' as const,
    controls: {
      env_scrub: control('best_effort', 'only the allowlist'),
      home_isolation: control('best_effort', 'HOME in the run dir'),
      fs_write_confinement: control('best_effort', 'no OS isolation'),
      egress: control('absent', 'no egress proxy configured'),
      process_group_kill: control('enforced', 'grandchild gone'),
    },
    child_env_keys: ['HOME', 'PATH'],
    notes: [],
    checked_at: 'now',
  },
};

const runSummary = {
  id: 'run_x',
  row: 'FW-C-001',
  status: 'succeeded',
  failure_class: null,
  adapter: 'fake',
  attempt: 1,
  branch: 'fw/FW-C-001/run_x',
  queued_at: 'now',
  ended_at: 'now',
  cost_usd: null,
};

const spendRow = { tokens_in: 10, tokens_out: 2, tokens_cached: 0, first_ts: 'now', last_ts: 'now' };
/** Two agents with spend (one of them with a run that reported no cost) and one with no spend at all. */
const spendByAgent = [
  { ...spendRow, agent_id: 'agt_two', usd: 0.5, entries: 1, unknown_runs: 0 },
  { ...spendRow, agent_id: 'agt_one', usd: 0.1875, entries: 2, unknown_runs: 1 },
  { ...spendRow, agent_id: 'agt_none', usd: null, entries: 0, unknown_runs: 2, tokens_in: 0, tokens_out: 0 },
];

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
    const listed = r.out.split('\n').filter((l) => l.startsWith('  fw '));
    expect(listed).toHaveLength(COMMANDS.length);
    // Each line starts with its command's words, in order (commands are one or two words).
    COMMANDS.forEach((c, i) => {
      const words = listed[i]!.trim()
        .split(/\s+/)
        .slice(1, 1 + c.path.length);
      expect(words.join(' ')).toBe(c.path.join(' '));
    });
    expect(helpText()).toContain('exit codes');
  });

  test('the help names exit code 3 for a policy refusal', () => {
    expect(helpText()).toMatch(/3 refused by policy/);
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

describe('doctor and gc', () => {
  test('fw doctor prints every control with its level', async () => {
    const r = await run(['doctor']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toMatch(/overall absent/);
    for (const [name, c] of Object.entries(doctorReport.sandbox.controls))
      expect(r.out).toMatch(new RegExp(`${name}\\s+${c.level}\\s+${c.detail}`));
  });

  test('fw doctor --json is the report', async () => {
    const r = await run(['doctor', '--json']);
    expect(JSON.parse(r.out)).toEqual(doctorReport);
  });

  test('fw gc reports what it removed and what it kept', async () => {
    const r = await run(['gc']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('removed 1 run directory, kept 1 of active runs');
    expect(r.out).toContain('removed run_done (succeeded)');
    expect(r.out).toContain('kept    run_live (running)');
  });

  test.each([['doctor'], ['gc']])(
    'fw %s on a client without it exits 1 with CLIENT_UNAVAILABLE',
    async (cmd) => {
      const r = await run([cmd, '--json'], fakeClient({ [cmd]: undefined }));
      expect(r.code).toBe(EXIT.FAILED);
      expect(JSON.parse(r.out).error.code).toBe('CLIENT_UNAVAILABLE');
    },
  );
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

  test('a failed run start exits 1 with the failure class and reason', async () => {
    const base = await fakeClient().runStart!('FW-C-001');
    const r = await run(
      ['run', 'start', 'FW-C-001', '--adapter', 'fake', '--scenario', 'over_budget'],
      fakeClient({
        runStart: async () => ({
          ...base,
          ok: false,
          status: 'killed',
          failure_class: 'budget',
          reason: 'usd cap 0.5 exceeded',
          pr: null,
        }),
      }),
    );
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.out).toContain('killed (budget) run_x: usd cap 0.5 exceeded');
  });

  test('run commands on a client without them exit 1 with CLIENT_UNAVAILABLE', async () => {
    const r = await run(['run', 'list', '--json'], fakeClient({ runList: undefined }));
    expect(r.code).toBe(EXIT.FAILED);
    expect(JSON.parse(r.out).error.code).toBe('CLIENT_UNAVAILABLE');
  });

  test('run show without spend says the cost is unknown, and prints the bundle hash', async () => {
    const r = await run(['run', 'show', 'run_x']);
    expect(r.out).toContain('unknown (no spend recorded)');
    expect(r.out).toContain('b'.repeat(64));
  });

  test('--max-wall-clock-s must be a positive whole number', async () => {
    const r = await run(['run', 'start', 'FW-C-001', '--max-wall-clock-s', '0']);
    expect(r.code).toBe(EXIT.USAGE);
  });

  test('a held writer lock exits 4', async () => {
    const e = Object.assign(new Error('event log writer lock is held by pid 1'), { code: 'LOCKED' });
    const r = await run(['ledger', 'sync'], fakeClient({ ledgerSync: async () => Promise.reject(e) }));
    expect(r.code).toBe(EXIT.LOCKED);
  });

  test.each([
    ['SIZE_NOT_DISPATCHABLE', 'size XL has no caps in the core policy size table'],
    ['SELF_VERIFY', 'self-verification refused: agt_w cannot be both doer and verifier of FW-C-001'],
    ['DIFF_POLICY', 'diff policy violation'],
  ])(
    'a policy refusal (%s) from wo issue exits 3 under --json with one JSON document',
    async (code, message) => {
      const e = Object.assign(new Error(message), { code });
      const r = await run(
        ['wo', 'issue', 'FW-C-001', '--json'],
        fakeClient({ woIssue: async () => Promise.reject(e) }),
      );
      expect(r.code).toBe(EXIT.POLICY);
      expect(JSON.parse(r.out).error.code).toBe(code);
    },
  );

  test('a policy refusal exits 3 without --json too, with the reason on stderr', async () => {
    const e = Object.assign(new Error('size XL is not dispatchable'), { code: 'SIZE_NOT_DISPATCHABLE' });
    const r = await run(
      ['run', 'start', 'FW-C-001'],
      fakeClient({ runStart: async () => Promise.reject(e) }),
    );
    expect(r.code).toBe(EXIT.POLICY);
    expect(r.err).toBe('fw run start: size XL is not dispatchable');
  });

  test('a run refused by the diff policy exits 3; the code is mapped, not the message', async () => {
    const base = await fakeClient().runStart!('FW-C-001');
    const failed = {
      ...base,
      ok: false,
      status: 'failed',
      failure_class: 'no_artifact',
      reason: 'diff policy violation (tier0_path CODEOWNERS); branch quarantined as fw/quarantine/run_x',
      pr: null,
    };
    const refused = await run(
      ['run', 'start', 'FW-C-001', '--json'],
      fakeClient({ runStart: async () => ({ ...failed, policy_code: 'DIFF_POLICY' }) }),
    );
    expect(refused.code).toBe(EXIT.POLICY);
    expect(JSON.parse(refused.out).policy_code).toBe('DIFF_POLICY');
    // The same words without the code are an ordinary failure: the CLI never reads the message.
    const plain = await run(['run', 'start', 'FW-C-001'], fakeClient({ runStart: async () => failed }));
    expect(plain.code).toBe(EXIT.FAILED);
  });

  test.each([
    ['ROW_NOT_READY', EXIT.FAILED],
    ['ALREADY_ISSUED', EXIT.FAILED],
    ['REFUSED_BY_DATABASE', EXIT.FAILED],
    ['INTERNAL', EXIT.FAILED],
    ['LOCKED', EXIT.LOCKED],
  ])('%s is not a policy refusal (exit %i)', async (code, want) => {
    const e = Object.assign(new Error('refused by policy, says the message'), { code });
    const r = await run(['wo', 'issue', 'FW-C-001'], fakeClient({ woIssue: async () => Promise.reject(e) }));
    expect(r.code).toBe(want);
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

describe('fw spend (WS-P0-025)', () => {
  test('--json prints the rollup per agent with a total; a missing cost is null, never 0', async () => {
    const r = await run(['spend', '--by', 'agent', '--json']);
    expect(r.code).toBe(EXIT.OK);
    const body = JSON.parse(r.out);
    expect(body.by).toBe('agent');
    expect(body.groups).toEqual(spendByAgent);
    expect(body.total).toEqual({ usd: 0.6875, entries: 3, unknown_runs: 3 });
  });

  test('the default grouping is agent', async () => {
    let asked: string | undefined;
    await run(
      ['spend', '--json'],
      fakeClient({
        spendRollup: async ({ by }) => {
          asked = by;
          return [];
        },
      }),
    );
    expect(asked).toBe('agent');
  });

  test('the text form prints unknown for a group with no reported cost, and never $0', async () => {
    const r = await run(['spend', '--by', 'agent']);
    expect(r.code).toBe(EXIT.OK);
    const line = (id: string) => r.out.split('\n').find((l) => l.startsWith(id)) ?? '';
    expect(line('agt_two')).toContain('$0.5000');
    expect(line('agt_one')).toContain('$0.1875');
    expect(line('agt_none')).toMatch(/\bunknown\b/);
    expect(r.out).not.toMatch(/\$0\.0000/);
    expect(line('total')).toContain('$0.6875');
    expect(r.out).toMatch(/3 runs reported no cost \(unknown/);
  });

  test('a rollup where nothing reported a cost has an unknown total', async () => {
    const none = spendByAgent.slice(2);
    const r = await run(['spend', '--by', 'run', '--json'], fakeClient({ spendRollup: async () => none }));
    expect(JSON.parse(r.out).total).toEqual({ usd: null, entries: 0, unknown_runs: 2 });
    const t = await run(['spend', '--by', 'run'], fakeClient({ spendRollup: async () => none }));
    expect(t.out.split('\n').find((l) => l.startsWith('total'))).toMatch(/\bunknown\b/);
  });

  test.each(['agent', 'run', 'vendor', 'day', 'project'])('--by %s is passed to the client', async (by) => {
    let asked: string | undefined;
    const r = await run(
      ['spend', '--by', by],
      fakeClient({
        spendRollup: async (o) => {
          asked = o.by;
          return [];
        },
      }),
    );
    expect(r.code).toBe(EXIT.OK);
    expect(asked).toBe(by);
    expect(r.out).toBe('no spend recorded');
  });

  test('an unknown grouping is a usage error', async () => {
    const r = await run(['spend', '--by', 'moon', '--json']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.out).error.code).toBe('BAD_ARGUMENT');
  });

  test('a client without the rollup exits 1 with CLIENT_UNAVAILABLE', async () => {
    const r = await run(['spend', '--json'], fakeClient({ spendRollup: undefined }));
    expect(r.code).toBe(EXIT.FAILED);
    expect(JSON.parse(r.out).error.code).toBe('CLIENT_UNAVAILABLE');
  });
});

describe('working directory', () => {
  test('INIT_CWD is used only when fw was started by the `pnpm fw` script', () => {
    expect(invocationCwd({ npm_lifecycle_event: 'fw', INIT_CWD: '/typed/here' }, '/workspace')).toBe(
      '/typed/here',
    );
    // Another pnpm script (pnpm probe, pnpm test) leaks INIT_CWD into an fw it spawns elsewhere.
    expect(invocationCwd({ npm_lifecycle_event: 'probe', INIT_CWD: '/workspace' }, '/fixture')).toBe(
      '/fixture',
    );
    expect(invocationCwd({ INIT_CWD: '/workspace' }, '/fixture')).toBe('/fixture');
    expect(invocationCwd({ npm_lifecycle_event: 'fw' }, '/workspace')).toBe('/workspace');
  });
});
