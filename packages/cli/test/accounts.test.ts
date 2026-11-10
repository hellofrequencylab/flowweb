// fw accounts check on a fake machine: the calls made, the report, and that a secret never reaches
// argv, output or the saved report.
import { afterEach, describe, expect, test } from 'vitest';
import type { System } from '../src/accounts/system.ts';
import type { CoreClient } from '../src/client.ts';
import { setAccountsSystem } from '../src/commands/accounts.ts';
import { EXIT, type Io, main } from '../src/index.ts';
import { AKEY, fakeSystem, OKEY, TOKEN } from './fake-machine.ts';

async function fw(argv: string[], sys: System) {
  setAccountsSystem(() => sys);
  const out: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => out.push(t), env: {}, cwd: '/' };
  const code = await main(argv, io, () => ({ close() {} }) as unknown as CoreClient);
  return { code, text: out.join('\n') };
}

function noLeak(text: string) {
  for (const s of [TOKEN, AKEY, OKEY]) expect(text).not.toContain(s);
}

afterEach(() => setAccountsSystem(() => undefined as never));

describe('fw accounts check', () => {
  test('everything works: four passes and the fwd start line', async () => {
    const f = fakeSystem({
      secrets: { crd_claude0002: TOKEN, crd_claude0001: AKEY, crd_codex0001: OKEY },
      claude: true,
      codex: true,
      codexSignedIn: true,
    });
    const { code, text } = await fw(['accounts', 'check'], f.sys);
    expect(code).toBe(EXIT.OK);
    expect(text.match(/PASS/g)).toHaveLength(4);
    expect(text).toContain('FW_CLAUDE_AUTH=signin FW_CODEX_AUTH=signin pnpm fwd');
    // The Claude call runs on the stored token in a fresh HOME, with no key from the shell.
    const call = f.calls.find((c) => c.cmd === 'claude' && c.args[0] === '-p');
    expect(call?.opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(call?.opts.env?.HOME).toBe('/tmp/fw-accounts-x');
    expect(call?.opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    const exec = f.calls.find((c) => c.cmd === 'codex' && c.args[0] === 'exec' && c.args[1] !== '--help');
    expect(exec?.args).toEqual(expect.arrayContaining(['--skip-git-repo-check', '--sandbox', 'read-only']));
    expect(exec?.opts.env?.CODEX_API_KEY).toBeUndefined();
    expect(f.http.map((h) => new URL(h.url).host)).toEqual(['api.anthropic.com', 'api.openai.com']);
    // Secrets go only into env and headers: never argv, output or the saved report.
    for (const c of f.calls) noLeak(c.args.join(' '));
    noLeak(text);
    noLeak(JSON.stringify(f.report()));
    expect(f.report()).toMatchObject({ fwd_env: { FW_CLAUDE_AUTH: 'signin', FW_CODEX_AUTH: 'signin' } });
  });

  test('nothing set up: missing, a fix for each, no start line, exit 1', async () => {
    const f = fakeSystem({ secrets: {}, claude: true, codex: false });
    const { code, text } = await fw(['accounts', 'check'], f.sys);
    expect(code).toBe(EXIT.FAILED);
    expect(text).toContain('No account works yet. Run: pnpm fw accounts connect');
    expect(text).toContain('npm install -g @openai/codex');
    expect(f.calls.some((c) => c.args[0] === '-p')).toBe(false);
    expect(f.http).toHaveLength(0);
  });

  test('a refused token fails with a redacted reason and the setup-token fix', async () => {
    const f = fakeSystem({
      secrets: { crd_claude0002: TOKEN },
      claude: true,
      codex: true,
      codexSignedIn: true,
      claudeAnswer: {
        code: 1,
        stdout: `{"type":"result","is_error":true,"result":"Invalid bearer token ${TOKEN}"}`,
        stderr: '',
      },
      http: { 'api.openai.com': 401 },
    });
    const { code, text } = await fw(['accounts', 'check', '--json'], f.sys);
    expect(code).toBe(EXIT.FAILED);
    noLeak(text);
    const r = JSON.parse(text);
    const claude = r.accounts.find((a: { id: string }) => a.id === 'claude_signin');
    expect(claude).toMatchObject({ set_up: true, ok: false });
    expect(claude.detail).toContain('[redacted]');
    expect(claude.fix).toContain('claude setup-token');
    expect(r.fwd_env).toEqual({ FW_CLAUDE_AUTH: null, FW_CODEX_AUTH: 'signin' });
    expect(r.start_command).toBe('FW_CODEX_AUTH=signin pnpm fwd');
  });

  test('--only claude checks only Claude; a bad --only is a usage error', async () => {
    const f = fakeSystem({ secrets: { crd_claude0002: TOKEN }, claude: true, codex: true });
    const { code } = await fw(['accounts', 'check', '--only', 'claude'], f.sys);
    expect(code).toBe(EXIT.OK); // the optional API key is skipped, not failed
    expect(f.calls.some((c) => c.cmd === 'codex')).toBe(false);
    expect((await fw(['accounts', 'check', '--only', 'gemini'], f.sys)).code).toBe(EXIT.USAGE);
  });
});
