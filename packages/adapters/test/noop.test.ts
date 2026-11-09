import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  ADAPTER_CREDENTIALS,
  ADAPTER_NAMES,
  createAdapter,
  createNoopAdapter,
  findSecrets,
  NOOP_DESCRIPTION,
} from '../src/index.ts';
import { type CaseKind, commonChecks, conformanceSuite } from './conformance.ts';
import {
  collect,
  FAKE_MARKER,
  fakeCredential,
  makeInput,
  makeWorktree,
  schemaErrors,
  steps,
} from './helpers.ts';

const noop = createNoopAdapter();

describe('noop adapter', () => {
  test('is registered, needs no credential and says plainly what it is', async () => {
    expect(ADAPTER_NAMES).toContain('noop');
    expect(ADAPTER_CREDENTIALS.noop).toEqual([]);
    const a = createAdapter('noop');
    expect(a.name).toBe('noop');
    expect(a.vendor).toBe('local');
    expect(a.capabilities).toEqual({
      supports_resume: false,
      supports_schema: true,
      supports_budget_cap: false,
    });
    const pre = await a.preflight();
    expect(pre.fingerprint).toEqual({
      name: 'noop',
      version: expect.any(String),
      help_sha256: createHash('sha256').update(NOOP_DESCRIPTION).digest('hex'),
    });
    expect(pre.verified_flags).toEqual([]);
    expect(await a.fingerprint()).toEqual(pre.fingerprint);
    expect(NOOP_DESCRIPTION).toMatch(/^noop adapter: .*no vendor.*changes no files/);
  });

  test('runs nothing, changes nothing, spends nothing and produces no artifact', async () => {
    const wt = makeWorktree();
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: wt.path, encoding: 'utf8' }).trim();
      const input = makeInput(wt);
      const c = await collect(noop.start(input));
      commonChecks(c);
      expect(schemaErrors('run-result.json', c.result)).toEqual([]);

      // run-result.json allows `completed` only with an artifact, so a run with none ends failed,
      // exit 0, failure class no_artifact: what the SDK engine reports for any such vendor run.
      expect(c.result).toMatchObject({
        run_id: input.run_id,
        work_order_id: input.work_order.id,
        adapter: { vendor: 'local', name: 'noop', model: 'noop' },
        status: 'failed',
        exit_code: 0,
        cost: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, usd: 0 },
        turns: 0,
        tool_call_count: 0,
        artifacts: [],
        claims: [],
      });
      expect(c.result.summary).toMatch(/^noop adapter: /);
      expect(c.meta).toMatchObject({
        failure_class: 'no_artifact',
        cap_breach: null,
        killed_reason: null,
        pgid: null,
        error_count: 0,
        artifact_sources: [],
        cost: { usd: 0, estimated: false },
      });
      expect(c.meta.fingerprint?.name).toBe('noop');

      // No process: no process events, and one prompt step that says it was recorded, not sent.
      expect(c.events.some((e) => e.type === 'process')).toBe(false);
      const st = steps(c.events);
      expect(st.map((s) => s.kind)).toEqual(['prompt']);
      expect(st[0]?.content).toContain('noop adapter');
      expect(st[0]?.content).toContain('recorded, not sent');

      // No files: the worktree is exactly as it was.
      expect(git('rev-parse', 'HEAD')).toBe(wt.base_commit);
      expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    } finally {
      wt.cleanup();
    }
  });

  test('a kill before it finishes stops the run', async () => {
    const wt = makeWorktree();
    try {
      const run = noop.start(makeInput(wt));
      const killed = run.kill('test kill');
      const c = await collect(run);
      await killed;
      commonChecks(c);
      expect(c.result.status).toBe('stopped');
      expect(c.meta.failure_class).toBe('killed');
      expect(c.meta.killed_reason).toBe('test kill');
      expect(c.events.some((e) => e.type === 'killed')).toBe(true);
      expect(run.pgid()).toBeNull();
    } finally {
      wt.cleanup();
    }
  });

  test('a credential value in the work order never leaves the adapter', async () => {
    const wt = makeWorktree();
    try {
      const secret = fakeCredential();
      const input = makeInput(wt, (i) => {
        i.work_order.goal = `${i.work_order.goal} ${secret}`;
      });
      const c = await collect(noop.start(input, { credentialEnv: { NOOP_TOKEN: secret } }));
      const blob = JSON.stringify([c.events, c.result, c.meta]);
      expect(blob).not.toContain(FAKE_MARKER);
      expect(findSecrets(blob)).toEqual([]);
      expect(blob).toContain('[REDACTED:credential]');
    } finally {
      wt.cleanup();
    }
  });
});

// The shared suite. The noop spawns no process and never produces an artifact or a failure of its
// own, so the cases that need one (an artifact, a nonzero exit, missing output, a process group to
// cap or kill) cannot be provoked; the tests above cover what the noop does instead.
const noopCases: Partial<Record<CaseKind, true>> = { session_id: true, secret_redaction: true };

conformanceSuite({
  label: 'noop',
  adapter: () => noop,
  setup: (kind, wt) => {
    if (!noopCases[kind]) return null;
    if (kind !== 'secret_redaction') return { input: makeInput(wt) };
    const secret = fakeCredential();
    return {
      input: makeInput(wt, (i) => {
        i.work_order.goal = `${i.work_order.goal} ${secret}`;
      }),
      opts: { credentialEnv: { NOOP_TOKEN: secret } },
    };
  },
});
