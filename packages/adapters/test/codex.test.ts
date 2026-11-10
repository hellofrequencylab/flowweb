import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildCodexArgv,
  CODEX_REQUIRED_FLAGS,
  createCodexAdapter,
  strictSchema,
  verifyCodexFlags,
} from '../src/index.ts';
import { type CaseKind, conformanceSuite } from './conformance.ts';
import { collect, FIXTURES, fakeCredential, makeInput, makeWorktree } from './helpers.ts';

const DIR = join(FIXTURES, 'codex');
const HELP = readFileSync(join(DIR, 'help-exec-0.167.0.txt'), 'utf8');
const REPLAY = join(DIR, 'replay-cli.mjs');
const TID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';

function helpWithout(flag: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const l of HELP.split('\n')) {
    if (/^\s{1,8}-/.test(l)) skipping = new RegExp(`(^|[ ,])${flag}([ ,]|$)`).test(l);
    else if (/^\S/.test(l)) skipping = false;
    if (!skipping) out.push(l);
  }
  return out.join('\n');
}

const execWith =
  (help: string, version = 'codex-cli 0.167.0', loginCode = 0) =>
  async (args: string[]) => {
    if (args[0] === '--version') return { stdout: `${version}\n`, stderr: '', code: 0 };
    if (args[0] === 'login')
      return { stdout: loginCode === 0 ? 'Logged in using ChatGPT\n' : '', stderr: '', code: loginCode };
    return { stdout: help, stderr: '', code: 0 };
  };

const apiKey = () => ({ CODEX_API_KEY: fakeCredential() });

describe('codex preflight', () => {
  for (const r of CODEX_REQUIRED_FLAGS) {
    test(`fails closed when ${r.flag} is absent`, async () => {
      const a = createCodexAdapter({ exec: execWith(helpWithout(r.flag)) });
      await expect(a.preflight()).rejects.toMatchObject({ name: 'AdapterError', code: 'missing_flag' });
    });
  }

  test('fails closed when the version is unreadable', async () => {
    const a = createCodexAdapter({ exec: execWith(HELP, 'unknown build') });
    await expect(a.preflight()).rejects.toMatchObject({ code: 'version_unreadable' });
  });

  test('fingerprint is version plus sha256 of the exec help text', async () => {
    const fp = await createCodexAdapter({ exec: execWith(HELP) }).fingerprint();
    expect(fp.name).toBe('codex');
    expect(fp.version).toBe('0.167.0');
    expect(fp.help_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('codex argv', () => {
  const verified = new Set(verifyCodexFlags(HELP));
  test('a fresh run: exec --json in the workspace-write sandbox, schema file, prompt on stdin', () => {
    expect(
      buildCodexArgv({ verified, resumeSessionId: null, schemaPath: '/s.json', model: 'gpt-5.5-codex' }),
    ).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--ignore-user-config',
      '--output-schema',
      '/s.json',
      '--model',
      'gpt-5.5-codex',
      '-',
    ]);
  });
  test('a resumed run: exec resume <id>, sandbox through --config', () => {
    expect(buildCodexArgv({ verified, resumeSessionId: TID, schemaPath: '/s.json' })).toEqual([
      'exec',
      'resume',
      TID,
      '--json',
      '--config',
      'sandbox_mode="workspace-write"',
      '--ignore-user-config',
      '--output-schema',
      '/s.json',
      '-',
    ]);
  });
  test('unsafe resume ids and unverified flags are refused', () => {
    expect(() => buildCodexArgv({ verified, resumeSessionId: 'x;rm -rf /', schemaPath: '/s' })).toThrow(
      /unsafe/,
    );
    expect(() => buildCodexArgv({ verified: new Set(), resumeSessionId: null, schemaPath: '/s' })).toThrow(
      /--json/,
    );
  });
  test('the report schema is strict: closed objects, every property required', () => {
    const s = strictSchema({
      type: 'object',
      properties: { a: { type: 'string', maxLength: 3 }, b: { type: 'array' } },
      required: ['a'],
    });
    expect(s).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'array' } },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });
});

describe('codex credentials and resume (replayed CLI)', () => {
  const replay = (fixture: string, extra: string[] = [], o: object = {}) =>
    createCodexAdapter({
      command: process.execPath,
      commandArgs: [REPLAY, join(DIR, fixture), ...extra],
      ...o,
    });

  test('the api_key lane refuses a run with no key before the CLI runs', async () => {
    const wt = makeWorktree();
    try {
      const c = await collect(
        replay('success.jsonl', ['--fw-commit']).start(makeInput(wt), { credentialEnv: {} }),
      );
      expect(c.result.status).toBe('refused');
      expect(c.events.some((e) => e.type === 'error' && e.code === 'credential_missing')).toBe(true);
    } finally {
      wt.cleanup();
    }
  });

  test('the sign-in lane runs on the CLI login under CODEX_HOME, with no key injected', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fw-codex-home-'));
    const wt = makeWorktree();
    try {
      const out = await collect(
        replay('success.jsonl', ['--fw-commit'], { auth: 'signin', codexHome: home }).start(
          makeInput(wt),
          {},
        ),
      );
      expect(out.result.status).toBe('refused');
      writeFileSync(join(home, 'auth.json'), '{"auth_mode":"chatgpt"}\n');
      const wt2 = makeWorktree();
      try {
        const ok = await collect(
          replay('success.jsonl', ['--fw-commit'], { auth: 'signin', codexHome: home }).start(
            makeInput(wt2),
            {},
          ),
        );
        expect(ok.result.status).toBe('completed');
      } finally {
        wt2.cleanup();
      }
    } finally {
      wt.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('resume: a second run passes exec resume <id> and keeps the session', async () => {
    const wt = makeWorktree();
    try {
      const first = await collect(
        replay('success.jsonl', ['--fw-commit']).start(makeInput(wt), { credentialEnv: apiKey() }),
      );
      expect(first.result.status).toBe('completed');
      const sid = first.result.session_id;
      expect(sid).toMatch(/^[0-9a-f-]{36}$/);
      const input = makeInput(wt);
      input.resume_session_id = sid;
      const second = await collect(
        replay('success.jsonl', ['--fw-commit']).start(input, { credentialEnv: apiKey() }),
      );
      expect(second.result.status).toBe('completed');
      expect(second.result.session_id).toBe(sid);
    } finally {
      wt.cleanup();
    }
  });
});

const replayCase: Record<CaseKind, string[]> = {
  success: ['success.jsonl', '--fw-commit'],
  nonzero_exit: ['no-result.jsonl', '--fw-exit=1'],
  missing_result: ['no-result.jsonl'],
  budget_cap: ['big-usage.jsonl', '--fw-hang-end'],
  wall_clock: ['success.jsonl', '--fw-hang'],
  session_id: ['success.jsonl', '--fw-commit'],
  secret_redaction: ['secret.jsonl', '--fw-commit'],
  kill: ['success.jsonl', '--fw-hang'],
};

conformanceSuite({
  label: 'codex (replayed CLI fixtures)',
  adapter: () => createCodexAdapter({ command: process.execPath, commandArgs: [REPLAY] }),
  setup: (kind, wt) => {
    const [fixture, ...flags] = replayCase[kind];
    return {
      adapter: createCodexAdapter({
        command: process.execPath,
        commandArgs: [REPLAY, join(DIR, fixture!), ...flags],
      }),
      input: makeInput(wt, (i) => {
        if (kind === 'wall_clock') i.caps.max_wall_clock_s = 1;
        if (kind === 'kill') i.caps.max_wall_clock_s = 60;
      }),
      opts: { killGraceMs: 300, credentialEnv: apiKey() },
    };
  },
});

const LIVE = process.env.FW_LIVE_VENDORS === '1';
conformanceSuite({
  label: 'codex (live, FW_LIVE_VENDORS=1)',
  skip: !LIVE,
  adapter: () => createCodexAdapter(),
  setup: (kind, wt) => {
    if (kind !== 'success' && kind !== 'session_id') return null;
    const key = process.env.CODEX_API_KEY;
    return {
      input: makeInput(wt, (i) => {
        i.work_order.goal = 'Create a file named hello.txt containing the word hello, then commit it.';
        i.budget = { max_usd: 0.25 };
        i.caps = { max_turns: 10, max_wall_clock_s: 300 };
      }),
      opts: key ? { credentialEnv: { CODEX_API_KEY: key } } : {},
    };
  },
});
