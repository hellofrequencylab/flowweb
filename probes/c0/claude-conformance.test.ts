// Probe c0/claude-conformance (WS-P0-030; backlog verify_probe adapters/claude-conformance).
// Surface: createClaudeAdapter({ command, commandArgs, exec }) and REQUIRED_FLAGS from
// packages/adapters/src/index.ts; the recorded-CLI fixtures in packages/adapters/test/fixtures/claude
// (replay-cli.mjs replays a stream-json transcript and prints the help text of Claude Code 2.1.319);
// the conformance suite registered for those fixtures in packages/adapters/test/claude.test.ts.
// The probe runs the vendor through a stub that logs every argv and then hands over to the replay
// CLI, so it can prove what was (and was not) run. Credentials reach the adapter as
// StartOptions.credentialEnv (the daemon injects them); the API-key lane is ANTHROPIC_API_KEY and
// CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN (subscription or OAuth kinds) are refused.
// Acceptance (WS-P0-030):
//   - passes the conformance suite against a recorded-CLI fixture (all 8 cases)
//   - refuses to start if the credential kind is not api_key, before the CLI runs with a prompt
//   - stores session_id and resumes it in a second run: the second run passes --resume <id> and
//     reports the same session id. Storing it on the runs row is proven by c0/run-fake-e2e.
//   - (KICKOFF Prompt 4) preflight fails closed when --help lacks a required flag, and the fingerprint
//     is the CLI version plus sha256 of the help text
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { adapterInput, drain, fakeSecret, requireExport, root, sha256, tmpDir } from './_lib.mjs';

type Adapter = { preflight: () => Promise<unknown>; fingerprint: () => Promise<{ version: string; help_sha256: string }> };
type Create = (o: Record<string, unknown>) => Adapter;

const FIX = join(root, 'packages/adapters/test/fixtures/claude');
const HELP = readFileSync(join(FIX, 'help-2.1.319.txt'), 'utf8');

/** A `claude` stand-in: logs its argv, then runs the replay CLI with the same argv. */
function stub() {
  const dir = tmpDir('claude-stub');
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'claude-stub.mjs');
  writeFileSync(
    bin,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
await import(${JSON.stringify(pathToFileURL(join(FIX, 'replay-cli.mjs')).href)});
`,
  );
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
      : [];
  const prompted = () => calls().filter((c) => !c.includes('--help') && !c.includes('--version'));
  return { bin, calls, prompted };
}

async function create() {
  return (await requireExport('adapters', 'createClaudeAdapter', 'WS-P0-030')) as Create;
}

const apiKey = () => ({ ANTHROPIC_API_KEY: fakeSecret('anthropic') });

describe('c0/claude-conformance', () => {
  test('the conformance suite passes against the recorded-CLI fixtures', () => {
    const dir = tmpDir('claude-suite');
    const report = join(dir, 'report.json');
    spawnSync(
      join(root, 'node_modules/.bin/vitest'),
      ['run', 'packages/adapters/test/claude.test.ts', '--reporter=json', '--outputFile', report],
      { cwd: root, encoding: 'utf8', timeout: 200_000, env: { ...process.env, FW_LIVE_VENDORS: '' } },
    );
    expect(existsSync(report), 'vitest wrote a report for packages/adapters/test/claude.test.ts').toBe(true);
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[];
    };
    const cases = json.testResults
      .flatMap((t) => t.assertionResults)
      .filter((a) => a.ancestorTitles.includes('adapter conformance: claude (replayed CLI fixtures)'));
    expect(cases.length, 'all 8 conformance cases run against the fixtures').toBe(8);
    expect(cases.filter((a) => a.status !== 'passed').map((a) => a.title), 'failing cases').toEqual([]);
  }, 240_000);

  test('preflight fails closed when --help lacks a required flag; fingerprint is version + sha256(help)', async () => {
    const createClaudeAdapter = await create();
    const flags = (await requireExport('adapters', 'REQUIRED_FLAGS', 'WS-P0-030')) as { flag: string }[];
    const s = stub();
    const dropped = flags[flags.length - 1].flag;
    const partial = HELP.split('\n')
      .filter((l) => !l.includes(dropped))
      .join('\n');
    expect(partial, `the fixture help without ${dropped}`).not.toContain(dropped);
    const exec = (help: string) => async (args: string[]) =>
      args.includes('--version') ? { code: 0, stdout: '2.1.319 (Claude Code)\n', stderr: '' } : { code: 0, stdout: help, stderr: '' };

    const bad = createClaudeAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl')], exec: exec(partial) });
    await expect(bad.preflight(), 'preflight rejects').rejects.toThrow(new RegExp(dropped));
    const out = await drain(bad as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: apiKey() } });
    expect(out.result.status, 'start is refused').toBe('refused');
    expect(s.prompted(), 'the CLI is never run with a prompt after a failed preflight').toEqual([]);

    const good = createClaudeAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl')], exec: exec(HELP) });
    const fp = await good.fingerprint();
    expect(fp.version).toBe('2.1.319');
    expect(fp.help_sha256).toBe(sha256(HELP));
  });

  test('a credential that is not an API key is refused before the CLI runs', async () => {
    const createClaudeAdapter = await create();
    for (const env of [{ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-probe' }, { ANTHROPIC_AUTH_TOKEN: 'auth-token-probe' }, {}]) {
      const s = stub();
      const a = createClaudeAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl'), '--fw-commit'] });
      const out = await drain(a as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: env } });
      expect(out.result.status, `credential ${Object.keys(env).join(',') || '(none)'} is refused`).toBe('refused');
      expect(
        out.events.some((e: Record<string, unknown>) => e.type === 'error' && /credential_(rejected|missing)/.test(String(e.code))),
        'a typed credential error event',
      ).toBe(true);
      expect(s.prompted(), 'the CLI never ran with a prompt').toEqual([]);
    }
  });

  test('session id is stored and resumed by a second run', async () => {
    const createClaudeAdapter = await create();
    const s = stub();
    const a = createClaudeAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl'), '--fw-commit'] });
    const first = await drain(a as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: apiKey() } });
    expect(first.result.status).toBe('completed');
    const sid = first.result.session_id as string;
    expect(sid, 'the first run reports a session id').toBeTruthy();
    expect(s.prompted()[0], 'the first run passes --session-id <id>').toEqual(expect.arrayContaining(['--session-id', sid]));

    const input = adapterInput({ scenario: 'success' });
    input.resume_session_id = sid;
    const second = await drain(a as never, input, { opts: { credentialEnv: apiKey() } });
    expect(second.result.status).toBe('completed');
    expect(s.prompted()[1], 'the second run passes --resume <id>').toEqual(expect.arrayContaining(['--resume', sid]));
    expect(second.result.session_id, 'the resumed run reports the same session').toBe(sid);
  });
});
