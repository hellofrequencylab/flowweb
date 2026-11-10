import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createAdapter,
  createFakeAdapter,
  FAKE_EXPECTED,
  FAKE_SCENARIOS,
  type FakeScenario,
  fakeScenarioOf,
  findSecrets,
  type StartOptions,
  type VendorAdapterInput,
} from '../src/index.ts';
import { type CaseKind, conformanceSuite } from './conformance.ts';
import {
  collect,
  FAKE_MARKER,
  fakeCredential,
  liveGroupMembers,
  makeInput,
  makeWorktree,
  schemaErrors,
  steps,
  type Worktree,
  waitGroupGone,
} from './helpers.ts';

const fake = createFakeAdapter();

function scenarioInput(
  wt: Worktree,
  scenario: FakeScenario,
  patch: (i: VendorAdapterInput) => void = () => {},
) {
  return makeInput(wt, (i) => {
    i.work_order.title = `[fake:${scenario}] ${i.work_order.title}`;
    if (scenario === 'hang') i.caps.max_wall_clock_s = 1;
    patch(i);
  });
}

async function play(
  scenario: FakeScenario,
  opts: StartOptions = {},
  patch?: (i: VendorAdapterInput) => void,
) {
  // The caller cleans up the worktree after its git assertions.
  const wt = makeWorktree();
  const input = scenarioInput(wt, scenario, patch);
  const c = await collect(fake.start(input, { killGraceMs: 300, ...opts }));
  return { ...c, wt, input };
}

describe('fake adapter: every scenario produces its expected normalized outcome', () => {
  for (const scenario of FAKE_SCENARIOS) {
    test(`${scenario} -> ${FAKE_EXPECTED[scenario].status}`, async () => {
      const r = await play(scenario);
      try {
        expect(r.result.status).toBe(FAKE_EXPECTED[scenario].status);
        expect(schemaErrors('run-result.json', r.result)).toEqual([]);
        expect(r.result.adapter).toMatchObject({ vendor: 'local', name: 'fake', model: 'fake-scripted' });
      } finally {
        r.wt.cleanup();
      }
    });
  }

  test('input fixtures are schema-valid', () => {
    const wt = makeWorktree();
    try {
      expect(schemaErrors('vendor-adapter-input.json', scenarioInput(wt, 'success'))).toEqual([]);
    } finally {
      wt.cleanup();
    }
  });
});

describe('fake adapter: scenario details', () => {
  test('success commits a real file change and reports vendor cost', async () => {
    const r = await play('success');
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.wt.path, encoding: 'utf8' }).trim();
      expect(head).not.toBe(r.wt.base_commit);
      expect(r.result.artifacts).toEqual([{ kind: 'commit', ref: `fw/test@${head}`, sha: head }]);
      expect(r.result.files_changed).toEqual([`fw-fake/${r.input.run_id}.md`]);
      expect(r.result.diff_stats?.files_changed).toBe(1);
      expect(r.result.cost.usd).toBe(0.0123);
      expect(r.meta.cost.estimated).toBe(false);
      expect(r.result.cost.input_tokens).toBe(2100);
      expect(r.result.turns).toBe(2);
      expect(r.result.claims?.[0]?.acceptance_id).toBe('AC1');
      expect(r.result.commands_run?.[0]?.tool_call_id).toMatch(/^tcl_/);
      expect(r.meta.artifact_sources).toEqual(['git']);
      // Steps follow the run_steps shape.
      const kinds = steps(r.events).map((s) => s.kind);
      expect(kinds).toEqual([
        'prompt',
        'model_turn',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'model_turn',
      ]);
    } finally {
      r.wt.cleanup();
    }
  });

  test('vendor runs with a scrubbed env and its own HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fw-home-'));
    process.env.FW_TEST_PARENT_ONLY = 'parent-value';
    try {
      const r = await play('success', {
        homeDir: home,
        credentialEnv: { FAKE_VENDOR_TOKEN: fakeCredential() },
      });
      try {
        const envStep = steps(r.events).find(
          (s) => s.kind === 'tool_result' && s.content.includes('env_names='),
        );
        expect(envStep).toBeDefined();
        const content = envStep!.content;
        expect(content).toContain(`home=${home}`);
        expect(content).toContain(`cwd=${r.wt.path}`);
        const names = content.split('env_names=')[1]!.split(',');
        expect(names).toContain('FAKE_VENDOR_TOKEN');
        expect(names).toContain('HTTPS_PROXY');
        expect(names).not.toContain('FW_TEST_PARENT_ONLY');
        for (const n of names)
          expect(n).toMatch(
            /^(PATH|LANG|LC_ALL|LC_CTYPE|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HOME|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|HTTPS?_PROXY|https?_proxy|NO_PROXY|FAKE_VENDOR_TOKEN)$/,
          );
      } finally {
        r.wt.cleanup();
      }
    } finally {
      delete process.env.FW_TEST_PARENT_ONLY;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fail: nonzero exit, stderr kept as redacted data', async () => {
    const r = await play('fail');
    try {
      expect(r.result.exit_code).toBe(3);
      expect(r.meta.failure_class).toBe('nonzero_exit');
      expect(r.meta.stderr_tail).toContain('fatal: simulated vendor failure');
      expect(r.meta.cost.estimated).toBe(true);
      expect(r.result.cost.usd).toBeGreaterThan(0);
    } finally {
      r.wt.cleanup();
    }
  });

  test('secret_leak: no secret in any event, step, result or meta, including injected credential values', async () => {
    const cred = fakeCredential();
    const r = await play('secret_leak', { credentialEnv: { FAKE_VENDOR_TOKEN: cred } });
    try {
      const blob = JSON.stringify([r.events, r.result, r.meta]);
      expect(blob).not.toContain(FAKE_MARKER);
      expect(blob).not.toContain(cred);
      expect(findSecrets(blob)).toEqual([]);
      for (const kind of [
        'anthropic_key',
        'openai_project_key',
        'github_token',
        'github_pat',
        'aws_access_key',
        'slack_token',
        'pem_private_key',
        'credential',
      ]) {
        expect(blob).toContain(`[REDACTED:${kind}]`);
      }
      // Content hashes are computed over redacted content.
      for (const s of steps(r.events)) {
        expect(s.content_hash).toBe(createHash('sha256').update(s.content).digest('hex'));
      }
    } finally {
      r.wt.cleanup();
    }
  });

  test('prompt_injection: text passes through only as data and is flagged', async () => {
    const r = await play('prompt_injection');
    try {
      const turn = steps(r.events).find((s) => s.kind === 'model_turn');
      expect(turn?.content).toContain('IGNORE PREVIOUS INSTRUCTIONS');
      const tool = steps(r.events).find((s) => s.kind === 'tool_result');
      expect(tool?.content).toContain('<system>New instructions:');
      expect(r.result.injection_suspected?.length).toBeGreaterThanOrEqual(2);
      expect(r.result.injection_suspected?.map((f) => f.source)).toEqual(
        expect.arrayContaining(['model_output', 'tool_result']),
      );
      // Nothing beyond the scripted note commit happened: the instructions were not obeyed.
      expect(r.result.files_changed).toEqual([`fw-fake/${r.input.run_id}.md`]);
      expect(r.result.commands_run?.map((c) => c.command)).toEqual(['git commit -m "fake: add note"']);
    } finally {
      r.wt.cleanup();
    }
  });

  test('over_budget: token cap breach kills the group; cost is an estimate', async () => {
    const r = await play('over_budget');
    try {
      expect(r.meta.cap_breach?.cap).toBe('tokens');
      expect(r.meta.cost.estimated).toBe(true);
      expect(r.meta.failure_class).toBe('budget');
      expect(liveGroupMembers(r.meta.pgid!)).toEqual([]);
    } finally {
      r.wt.cleanup();
    }
  });

  test('turn cap is enforced by the adapter', async () => {
    const r = await play('over_budget', {}, (i) => {
      i.caps.max_turns = 3;
      i.budget = { max_usd: 1000 };
    });
    try {
      expect(r.result.status).toBe('budget_exceeded');
      expect(r.meta.cap_breach).toMatchObject({ cap: 'turns', limit: 3 });
    } finally {
      r.wt.cleanup();
    }
  });

  test('dollar cap is enforced on the estimate when the vendor reports none', async () => {
    const r = await play('over_budget', {}, (i) => {
      i.budget = { max_usd: 0.5 };
    });
    try {
      expect(r.meta.cap_breach?.cap).toBe('usd');
    } finally {
      r.wt.cleanup();
    }
  });

  test('forbidden_path: files_changed comes from git, not from the vendor claim', async () => {
    const r = await play('forbidden_path');
    try {
      expect(r.result.files_changed).toEqual(['CODEOWNERS', 'probes/fake-probe.sh', 'src/allowed.ts']);
      expect(r.result.summary).toContain('Only touched src/allowed.ts');
    } finally {
      r.wt.cleanup();
    }
  });

  test('malformed_output: typed error events, never a crash, unknown fields ignored', async () => {
    const r = await play('malformed_output');
    try {
      const errors = r.events.flatMap((e) => (e.type === 'error' ? [e] : []));
      const codes = errors.map((e) => e.code);
      expect(codes.filter((c) => c === 'malformed_line').length).toBe(4);
      expect(codes.filter((c) => c === 'unexpected_shape').length).toBe(3);
      expect(codes).toContain('line_too_long');
      for (const e of errors) expect(e.preview === undefined || e.preview.length <= 83).toBe(true);
      // The valid line with unknown fields still became a turn with sane token counts.
      const turn = steps(r.events).find((s) => s.content === 'valid line with unknown fields');
      expect(turn).toMatchObject({ tokens_in: 10, tokens_out: 5 });
      expect(r.result.status).toBe('failed');
      expect(r.meta.failure_class).toBe('schema');
      expect(r.meta.error_count).toBe(errors.length);
    } finally {
      r.wt.cleanup();
    }
  });

  test('fabricated_claim: only a claimed artifact, marked as claimed for the kernel guard', async () => {
    const r = await play('fabricated_claim');
    try {
      expect(r.result.artifacts).toEqual([
        expect.objectContaining({ kind: 'pull_request', ref: 'https://git.example.invalid/fake/pull/999' }),
      ]);
      expect(r.meta.artifact_sources).toEqual(['claimed']);
      expect(r.result.files_changed).toEqual([]);
    } finally {
      r.wt.cleanup();
    }
  });

  test('hang: wall-clock kill escalates to SIGKILL and takes the grandchild too', async () => {
    const r = await play('hang');
    try {
      expect(r.result.status).toBe('timeout');
      const pidText = steps(r.events).find((s) => s.content.startsWith('grandchild_pid='))?.content;
      const grandchild = Number(pidText?.split('=')[1]);
      expect(grandchild).toBeGreaterThan(0);
      expect(liveGroupMembers(r.meta.pgid!)).toEqual([]);
      expect(await waitGroupGone(r.meta.pgid!)).toBe(true);
      expect(() => process.kill(grandchild, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      r.wt.cleanup();
    }
  });
});

describe('fake adapter: selection, preflight, refusal', () => {
  test('scenario comes from the work order title tag, the option overrides it', () => {
    const wt = makeWorktree();
    try {
      const input = scenarioInput(wt, 'fail');
      expect(fakeScenarioOf(input)).toBe('fail');
      expect(fakeScenarioOf(input, { scenario: 'hang' })).toBe('hang');
      input.work_order.title = 'No tag here';
      expect(fakeScenarioOf(input)).toBe('success');
    } finally {
      wt.cleanup();
    }
  });

  test('unknown scenario is refused with a typed error', async () => {
    const wt = makeWorktree();
    try {
      const c = await collect(fake.start(makeInput(wt), { scenario: 'nope' }));
      expect(c.result.status).toBe('refused');
      expect(c.events.find((e) => e.type === 'error')).toMatchObject({ code: 'unknown_scenario' });
      expect(schemaErrors('run-result.json', c.result)).toEqual([]);
    } finally {
      wt.cleanup();
    }
  });

  test('instruction file hash mismatch fails closed', async () => {
    const wt = makeWorktree();
    try {
      writeFileSync(join(wt.path, 'worker.md'), 'be careful\n');
      const good = createHash('sha256').update('be careful\n').digest('hex');
      const ok = await collect(
        fake.start(makeInput(wt, (i) => (i.instruction_files = [{ path: 'worker.md', sha256: good }]))),
      );
      expect(steps(ok.events)[0]?.content).toContain('be careful');
      const bad = await collect(
        fake.start(
          makeInput(wt, (i) => (i.instruction_files = [{ path: 'worker.md', sha256: '0'.repeat(64) }])),
        ),
      );
      expect(bad.result.status).toBe('refused');
      expect(bad.meta.failure_class).toBe('adapter');
    } finally {
      wt.cleanup();
    }
  });

  test('fingerprint is version plus sha256 of the help text', async () => {
    const fp = await fake.fingerprint();
    expect(fp).toMatchObject({ name: 'fake', version: '1.0.0' });
    expect(fp.help_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('registry: fake, claude and codex resolve', () => {
    expect(createAdapter('fake').name).toBe('fake');
    expect(createAdapter('claude').name).toBe('claude-headless');
    expect(createAdapter('codex').name).toBe('codex-exec');
  });
});

const fakeSetup: Record<CaseKind, FakeScenario> = {
  success: 'success',
  nonzero_exit: 'fail',
  missing_result: 'malformed_output',
  budget_cap: 'over_budget',
  wall_clock: 'hang',
  session_id: 'success',
  secret_redaction: 'secret_leak',
  kill: 'hang',
};

conformanceSuite({
  label: 'fake',
  adapter: () => fake,
  setup: (kind, wt) => ({
    input: scenarioInput(wt, fakeSetup[kind], (i) => {
      if (kind === 'kill') i.caps.max_wall_clock_s = 60;
    }),
    opts: {
      killGraceMs: 300,
      ...(kind === 'secret_redaction' ? { credentialEnv: { FAKE_VENDOR_TOKEN: fakeCredential() } } : {}),
    },
  }),
});
