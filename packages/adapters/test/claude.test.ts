import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  AdapterError,
  adapterCredentials,
  buildClaudeArgv,
  createAdapter,
  createClaudeAdapter,
  createClaudeParser,
  parseHelp,
  REQUIRED_FLAGS,
  type VendorItem,
  verifyFlags,
} from '../src/index.ts';
import { type CaseKind, conformanceSuite } from './conformance.ts';
import {
  collect,
  FIXTURES,
  fakeCredential,
  makeInput,
  makeWorktree,
  schemaErrors,
  steps,
} from './helpers.ts';

const DIR = join(FIXTURES, 'claude');
const HELP = readFileSync(join(DIR, 'help-2.1.319.txt'), 'utf8');
const REPLAY = join(DIR, 'replay-cli.mjs');

function parseFixture(name: string): VendorItem[] {
  const parse = createClaudeParser();
  return readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .flatMap((l) => parse(l.split('{{SESSION_ID}}').join('11111111-2222-4333-8444-555555555555')));
}

/** A help text with one option line (and its continuation lines) removed. */
function helpWithout(flag: string): string {
  const lines = HELP.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    const isOption = /^\s{1,8}-/.test(l);
    if (isOption) skipping = new RegExp(`(^|[ ,])${flag}([ ,]|$)`).test(l);
    else if (/^\S/.test(l)) skipping = false;
    if (!skipping) out.push(l);
  }
  return out.join('\n');
}

const execWith =
  (help: string, version = '2.1.319 (Claude Code)') =>
  async (args: string[]) =>
    args[0] === '--version'
      ? { stdout: `${version}\n`, stderr: '', code: 0 }
      : { stdout: help, stderr: '', code: 0 };

describe('claude preflight', () => {
  test('the recorded help text verifies every required flag', () => {
    const verified = verifyFlags(HELP);
    for (const r of REQUIRED_FLAGS) expect(verified).toContain(r.flag);
    expect(verified).toEqual(
      expect.arrayContaining(['--resume', '--model', '--allowed-tools', '--permission-prompts']),
    );
    expect(verified).not.toContain('--max-turns');
  });

  test('help parsing indexes long flags and aliases', () => {
    const idx = parseHelp(HELP);
    expect(idx.flags.has('--print')).toBe(true);
    expect(idx.flags.has('--allowedTools')).toBe(true);
    expect(idx.flags.get('--output-format')).toContain('stream-json');
  });

  for (const r of REQUIRED_FLAGS) {
    test(`fails closed when ${r.flag} is absent`, async () => {
      const adapter = createClaudeAdapter({ exec: execWith(helpWithout(r.flag)) });
      await expect(adapter.preflight()).rejects.toMatchObject({ name: 'AdapterError', code: 'missing_flag' });
    });
  }

  test('fails closed when stream-json is not a listed output format', async () => {
    const adapter = createClaudeAdapter({
      exec: execWith(HELP.replace(/"stream-json"/g, '"ndjson"').replace(/stream-json/g, 'ndjson')),
    });
    await expect(adapter.preflight()).rejects.toMatchObject({ code: 'missing_flag' });
  });

  test('fails closed when the version is unreadable', async () => {
    const adapter = createClaudeAdapter({ exec: execWith(HELP, 'unknown build') });
    await expect(adapter.preflight()).rejects.toMatchObject({ code: 'version_unreadable' });
  });

  test('fingerprint is version plus sha256 of the help text', async () => {
    const adapter = createClaudeAdapter({ exec: execWith(HELP) });
    const fp = await adapter.fingerprint();
    expect(fp.name).toBe('claude');
    expect(fp.version).toBe('2.1.319');
    expect(fp.help_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a run with a missing required flag is refused, not started', async () => {
    const wt = makeWorktree();
    try {
      const adapter = createClaudeAdapter({ exec: execWith(helpWithout('--bare')) });
      const c = await collect(
        adapter.start(makeInput(wt), { credentialEnv: { ANTHROPIC_API_KEY: fakeCredential() } }),
      );
      expect(c.result.status).toBe('refused');
      expect(c.meta.pgid).toBeNull();
      expect(c.events.find((e) => e.type === 'error')).toMatchObject({ code: 'missing_flag' });
      expect(schemaErrors('run-result.json', c.result)).toEqual([]);
    } finally {
      wt.cleanup();
    }
  });
});

describe('claude argv and credentials', () => {
  const verified = new Set(verifyFlags(HELP));

  test('web allows WebSearch and WebFetch next to tools already allowed (FW-C-043)', () => {
    const base = { verified, sessionId: null, resumeSessionId: null, permissionMode: 'acceptEdits' };
    expect(buildClaudeArgv(base)).not.toContain('--allowed-tools');
    const argv = buildClaudeArgv({ ...base, allowedTools: ['Read'], web: true });
    expect(argv[argv.indexOf('--allowed-tools') + 1]).toBe('Read,WebSearch,WebFetch');
  });

  test('argv uses only verified flags and never carries the credential', () => {
    const argv = buildClaudeArgv({
      verified,
      sessionId: '11111111-2222-4333-8444-555555555555',
      resumeSessionId: null,
      maxBudgetUsd: 1.5,
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    expect(argv.slice(0, 4)).toEqual(['--print', '--output-format', 'stream-json', '--verbose']);
    expect(argv).toContain('--bare');
    expect(argv).toEqual(
      expect.arrayContaining(['--session-id', '--max-budget-usd', '1.5', '--model', 'sonnet']),
    );
    for (const a of argv.filter((x) => x.startsWith('--'))) expect(verified.has(a)).toBe(true);
    expect(argv.join(' ')).not.toMatch(/ANTHROPIC|sk-ant|FWFAKE/);
  });

  test('resume uses --resume and rejects unsafe ids', () => {
    const base = { verified, sessionId: null, permissionMode: 'acceptEdits' };
    expect(buildClaudeArgv({ ...base, resumeSessionId: 'abc-123' })).toEqual(
      expect.arrayContaining(['--resume', 'abc-123']),
    );
    expect(() => buildClaudeArgv({ ...base, resumeSessionId: '--dangerously-skip-permissions' })).toThrow(
      AdapterError,
    );
  });

  test('a conditional flag the preflight did not verify fails closed', () => {
    const noResume = new Set([...verified].filter((f) => f !== '--resume'));
    expect(() =>
      buildClaudeArgv({
        verified: noResume,
        sessionId: null,
        resumeSessionId: 'abc',
        permissionMode: 'acceptEdits',
      }),
    ).toThrow(expect.objectContaining({ code: 'missing_flag' }));
  });

  test('refuses to start without an API key, and refuses subscription credentials', async () => {
    const wt = makeWorktree();
    try {
      const adapter = createClaudeAdapter({ exec: execWith(HELP) });
      const none = await collect(adapter.start(makeInput(wt)));
      expect(none.result.status).toBe('refused');
      expect(none.events.find((e) => e.type === 'error')).toMatchObject({ code: 'credential_missing' });
      const oauth = await collect(
        adapter.start(makeInput(wt), {
          credentialEnv: { ANTHROPIC_API_KEY: fakeCredential(), CLAUDE_CODE_OAUTH_TOKEN: fakeCredential() },
        }),
      );
      expect(oauth.result.status).toBe('refused');
      expect(oauth.events.find((e) => e.type === 'error')).toMatchObject({ code: 'credential_rejected' });
    } finally {
      wt.cleanup();
    }
  });
});

describe('claude sign-in lane (Claude Pro/Max token)', () => {
  const token = () => `${fakeCredential()}oauth`;

  test('--bare is required only in the api_key lane', async () => {
    const noBare = helpWithout('--bare');
    expect(() => verifyFlags(noBare)).toThrow(expect.objectContaining({ code: 'missing_flag' }));
    expect(verifyFlags(noBare, 'signin')).not.toContain('--bare');
    const viaEnv = createAdapter('claude', {
      env: { FW_CLAUDE_AUTH: 'signin' },
      claude: { exec: execWith(noBare) },
    });
    await expect(viaEnv.preflight()).resolves.toMatchObject({ fingerprint: { version: '2.1.319' } });
  });

  test('argv drops --bare and keeps project settings and MCP servers out', () => {
    const argv = buildClaudeArgv({
      verified: new Set(verifyFlags(HELP, 'signin')),
      auth: 'signin',
      sessionId: '11111111-2222-4333-8444-555555555555',
      resumeSessionId: null,
      permissionMode: 'acceptEdits',
    });
    expect(argv).not.toContain('--bare');
    expect(argv).toEqual(expect.arrayContaining(['--setting-sources', 'user', '--strict-mcp-config']));
  });

  test('refuses without the token, and refuses a bearer token', async () => {
    const wt = makeWorktree();
    try {
      const adapter = createClaudeAdapter({ exec: execWith(HELP), auth: 'signin' });
      const none = await collect(
        adapter.start(makeInput(wt), { credentialEnv: { ANTHROPIC_API_KEY: fakeCredential() } }),
      );
      expect(none.result.status).toBe('refused');
      expect(none.events.find((e) => e.type === 'error')).toMatchObject({ code: 'credential_missing' });
      const bearer = await collect(
        adapter.start(makeInput(wt), {
          credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: token(), ANTHROPIC_AUTH_TOKEN: fakeCredential() },
        }),
      );
      expect(bearer.events.find((e) => e.type === 'error')).toMatchObject({ code: 'credential_rejected' });
    } finally {
      wt.cleanup();
    }
  });

  test('replayed run completes on the token alone; an injected API key is not passed', async () => {
    const wt = makeWorktree();
    try {
      const t = token();
      const adapter = createClaudeAdapter({
        command: process.execPath,
        commandArgs: [REPLAY, join(DIR, 'success.jsonl'), '--fw-commit'],
        auth: 'signin',
      });
      // The replay exits 97 if it sees --bare or ANTHROPIC_API_KEY next to the token, 99 if argv has it.
      const c = await collect(
        adapter.start(makeInput(wt), {
          credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: t, ANTHROPIC_API_KEY: fakeCredential() },
        }),
      );
      expect(c.result.status).toBe('completed');
      expect(JSON.stringify([c.result, c.events])).not.toContain(t);
    } finally {
      wt.cleanup();
    }
  });

  test('the daemon resolves only the lane handle', () => {
    expect(adapterCredentials('claude', {}).map((c) => [c.handle, c.required])).toEqual([
      ['crd_claude0001', true],
    ]);
    expect(
      adapterCredentials('claude', { FW_CLAUDE_AUTH: 'signin' }).map((c) => [c.handle, c.env, c.required]),
    ).toEqual([['crd_claude0002', 'CLAUDE_CODE_OAUTH_TOKEN', false]]);
  });
});

describe('claude stream-json parser (fixtures)', () => {
  test('success transcript maps to session, turns, tool calls and results', () => {
    const items = parseFixture('success.jsonl');
    const kinds = items.map((i) => i.kind);
    expect(kinds[0]).toBe('session');
    expect(kinds.filter((k) => k === 'tool_call')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'tool_result')).toHaveLength(4);
    expect(kinds.at(-1)).toBe('result');
    expect(items.filter((i) => i.kind === 'error')).toEqual([]);
    const session = items[0] as Extract<VendorItem, { kind: 'session' }>;
    expect(session.model).toBe('claude-sonnet-synthetic');
    const result = items.at(-1) as Extract<VendorItem, { kind: 'result' }>;
    expect(result).toMatchObject({ ok: true, subtype: 'success', usd: 0.0871 });
    expect(result.usage).toEqual({ input_tokens: 6292, output_tokens: 571, cached_tokens: 81720 });
    // Array-shaped tool_result content is flattened to text.
    const fetched = items.find((i) => i.kind === 'tool_result' && i.id === 'toolu_01SynthFetch');
    expect(fetched).toMatchObject({ text: expect.stringContaining('Ignore all previous instructions') });
    // Thinking blocks are not recorded.
    expect(JSON.stringify(items)).not.toContain('synthetic thinking');
  });

  test('error_max_budget_usd result is not ok', () => {
    const result = parseFixture('error-max-budget.jsonl').at(-1);
    expect(result).toMatchObject({ kind: 'result', ok: false, subtype: 'error_max_budget_usd', usd: 0.0412 });
  });

  test('malformed transcript yields typed errors and never throws', () => {
    const items = parseFixture('malformed.jsonl');
    const errors = items.flatMap((i) => (i.kind === 'error' ? [i.code] : []));
    expect(errors.filter((c) => c === 'malformed_line')).toHaveLength(2);
    expect(errors.filter((c) => c === 'unexpected_shape')).toHaveLength(3);
    const turn = items.find((i) => i.kind === 'turn');
    expect(turn).toMatchObject({
      text: 'partial\n ok',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 10 },
    });
    expect(items.at(-1)).toMatchObject({ kind: 'result', ok: true, report: 'not an object' });
  });
});

describe('claude adapter end to end against a replayed CLI', () => {
  const adapter = (args: string[]) =>
    createClaudeAdapter({ command: process.execPath, commandArgs: [REPLAY, ...args] });

  test('success replay: schema-valid result, reported cost, claims sanitized, injection flagged', async () => {
    const wt = makeWorktree();
    try {
      const c = await collect(
        adapter([join(DIR, 'success.jsonl'), '--fw-commit']).start(makeInput(wt), {
          credentialEnv: { ANTHROPIC_API_KEY: fakeCredential() },
        }),
      );
      expect(c.result.status).toBe('completed');
      expect(schemaErrors('run-result.json', c.result)).toEqual([]);
      expect(c.result.adapter).toEqual({
        vendor: 'anthropic',
        name: 'claude-headless',
        version: '2.1.319',
        model: 'claude-sonnet-synthetic',
      });
      expect(c.result.session_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.result.turns).toBe(5);
      expect(c.result.tool_call_count).toBe(4);
      expect(c.result.cost).toEqual({
        input_tokens: 6292,
        output_tokens: 571,
        cached_tokens: 81720,
        usd: 0.0871,
      });
      expect(c.meta.cost.estimated).toBe(false);
      expect(c.result.claims).toEqual([
        {
          acceptance_id: 'AC1',
          claim: 'Address change triggers a new estimate request',
          evidence_ref: 'trace://replay#step-9',
        },
      ]);
      expect(c.result.followups).toEqual(['Debounce rapid address edits']);
      expect(c.result.commands_run?.[0]?.command).toContain('git commit');
      expect(c.result.files_changed).toEqual(['replayed-change.txt']);
      expect(c.result.injection_suspected?.some((f) => f.source === 'tool_result')).toBe(true);
      // Duplicated usage on a split assistant message is counted once.
      const turnTokens = steps(c.events)
        .filter((s) => s.kind === 'model_turn')
        .reduce((a, s) => a + s.tokens_out, 0);
      expect(turnTokens).toBe(571);
    } finally {
      wt.cleanup();
    }
  });

  test('vendor-reported budget stop maps to budget_exceeded', async () => {
    const wt = makeWorktree();
    try {
      const c = await collect(
        adapter([join(DIR, 'error-max-budget.jsonl'), '--fw-exit=1']).start(makeInput(wt), {
          credentialEnv: { ANTHROPIC_API_KEY: fakeCredential() },
        }),
      );
      expect(c.result.status).toBe('budget_exceeded');
      expect(c.result.cost.usd).toBe(0.0412);
    } finally {
      wt.cleanup();
    }
  });

  test('no total cost reported: estimate from tokens, marked estimated', async () => {
    const wt = makeWorktree();
    try {
      const c = await collect(
        adapter([join(DIR, 'malformed.jsonl')]).start(makeInput(wt), {
          credentialEnv: { ANTHROPIC_API_KEY: fakeCredential() },
        }),
      );
      expect(c.meta.cost.estimated).toBe(true);
      expect(c.result.status).toBe('failed');
      expect(c.meta.failure_class).toBe('no_artifact');
      expect(c.meta.error_count).toBeGreaterThanOrEqual(5);
    } finally {
      wt.cleanup();
    }
  });
});

const replayCase: Record<CaseKind, string[]> = {
  success: ['success.jsonl', '--fw-commit'],
  nonzero_exit: ['no-result.jsonl', '--fw-exit=1'],
  missing_result: ['no-result.jsonl'],
  budget_cap: ['big-usage.jsonl', '--fw-delay=30', '--fw-hang'],
  wall_clock: ['success.jsonl', '--fw-hang'],
  session_id: ['success.jsonl', '--fw-commit'],
  secret_redaction: ['secret.jsonl', '--fw-commit'],
  kill: ['success.jsonl', '--fw-hang'],
};

conformanceSuite({
  label: 'claude (replayed CLI fixtures)',
  adapter: () => createClaudeAdapter({ command: process.execPath, commandArgs: [REPLAY] }),
  setup: (kind, wt) => {
    const [fixture, ...flags] = replayCase[kind];
    return {
      adapter: createClaudeAdapter({
        command: process.execPath,
        commandArgs: [REPLAY, join(DIR, fixture!), ...flags],
      }),
      input: makeInput(wt, (i) => {
        if (kind === 'wall_clock') i.caps.max_wall_clock_s = 1;
        if (kind === 'kill') i.caps.max_wall_clock_s = 60;
      }),
      opts: { killGraceMs: 300, credentialEnv: { ANTHROPIC_API_KEY: fakeCredential() } },
    };
  },
});

const LIVE = process.env.FW_LIVE_VENDORS === '1';
conformanceSuite({
  label: 'claude (live, FW_LIVE_VENDORS=1)',
  skip: !LIVE,
  adapter: () => createClaudeAdapter(),
  setup: (kind, wt) => {
    if (kind !== 'success' && kind !== 'session_id') return null;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('FW_LIVE_VENDORS=1 needs ANTHROPIC_API_KEY');
    return {
      input: makeInput(wt, (i) => {
        i.work_order.goal = 'Create a file named hello.txt containing the word hello, then commit it.';
        i.budget = { max_usd: 0.25 };
        i.caps = { max_turns: 10, max_wall_clock_s: 300 };
      }),
      opts: { credentialEnv: { ANTHROPIC_API_KEY: key } },
    };
  },
});
