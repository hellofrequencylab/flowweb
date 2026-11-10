// Probe c1/codex-conformance (WS-P1-015; backlog verify_probe adapters/codex-conformance).
// Surface: createCodexAdapter({ command, commandArgs, exec, auth, codexHome }) and CODEX_REQUIRED_FLAGS
// from packages/adapters/src/index.ts; the recorded-CLI fixtures in packages/adapters/test/fixtures/codex
// (replay-cli.mjs replays a `codex exec --json` transcript and answers --version, `exec --help` and
// `login status` like Codex CLI 0.167.0; `login status` succeeds when $CODEX_HOME/auth.json exists);
// the conformance suite registered for those fixtures in packages/adapters/test/codex.test.ts.
// The probe runs the vendor through a stub that logs every argv and then hands over to the replay CLI.
// Acceptance (WS-P1-015):
//   - passes the conformance suite against recorded fixtures (all 8 cases)
//   - the event stream maps to the common Run Result without vendor fields leaking into the kernel:
//     the result and the events carry no Codex event names or ids (thread.started, item_N, ...)
//   - resume works in a two-step test: the second run passes `exec resume <id>` and reports the same
//     session id
//   - (KICKOFF Prompt 4, as for Claude) preflight fails closed when `codex exec --help` lacks a
//     required flag; the fingerprint is the CLI version plus sha256 of that help text
//   - credentials (Owner decision 16 in probes/c1/README.md): the API-key lane takes CODEX_API_KEY
//     from injected env only (never argv) and refuses to start without it; the sign-in lane
//     (auth: 'signin') runs on the Codex CLI's own login under CODEX_HOME with no key injected, and
//     refuses before the CLI runs with a prompt when `codex login status` fails
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { adapterInput, drain, requireExport, root, sha256, tmpDir } from '../c0/_lib.mjs';

type Adapter = { preflight: () => Promise<unknown>; fingerprint: () => Promise<{ version: string; help_sha256: string }> };
type Create = (o: Record<string, unknown>) => Adapter;

const FIX = join(root, 'packages/adapters/test/fixtures/codex');
const HELP = existsSync(join(FIX, 'help-exec-0.167.0.txt')) ? readFileSync(join(FIX, 'help-exec-0.167.0.txt'), 'utf8') : '';

/** A `codex` stand-in: logs its argv, then runs the replay CLI with the same argv. */
function stub() {
  const dir = tmpDir('codex-stub');
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'codex-stub.mjs');
  writeFileSync(
    bin,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env) }) + '\\n');
await import(${JSON.stringify(pathToFileURL(join(FIX, 'replay-cli.mjs')).href)});
`,
  );
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { argv: string[]; env: string[] })
      : [];
  const prompted = () => calls().filter((c) => c.argv.includes('--json'));
  return { bin, calls, prompted };
}

async function create() {
  return (await requireExport('adapters', 'createCodexAdapter', 'WS-P1-015')) as Create;
}

const key = () => `sk-${'proj'}-${'FwProbeFake0'.repeat(4)}`;
const VENDOR_NAMES = /thread\.started|turn\.(started|completed|failed)|item\.(started|completed)|"item_\d+"|agent_message|command_execution|thread_id|cached_input_tokens/;

describe('c1/codex-conformance', () => {
  test('the conformance suite passes against the recorded-CLI fixtures', () => {
    const dir = tmpDir('codex-suite');
    const report = join(dir, 'report.json');
    spawnSync(
      join(root, 'node_modules/.bin/vitest'),
      ['run', 'packages/adapters/test/codex.test.ts', '--reporter=json', '--outputFile', report],
      { cwd: root, encoding: 'utf8', timeout: 200_000, env: { ...process.env, FW_LIVE_VENDORS: '' } },
    );
    expect(existsSync(report), 'vitest wrote a report for packages/adapters/test/codex.test.ts').toBe(true);
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[];
    };
    const cases = json.testResults
      .flatMap((t) => t.assertionResults)
      .filter((a) => a.ancestorTitles.includes('adapter conformance: codex (replayed CLI fixtures)'));
    expect(cases.length, 'all 8 conformance cases run against the fixtures').toBe(8);
    expect(cases.filter((a) => a.status !== 'passed').map((a) => a.title), 'failing cases').toEqual([]);
  }, 240_000);

  test('preflight fails closed when exec --help lacks a required flag; fingerprint is version + sha256(help)', async () => {
    const createCodexAdapter = await create();
    const flags = (await requireExport('adapters', 'CODEX_REQUIRED_FLAGS', 'WS-P1-015')) as { flag: string }[];
    expect(HELP, 'packages/adapters/test/fixtures/codex/help-exec-0.167.0.txt exists').not.toBe('');
    const s = stub();
    const dropped = flags[0].flag;
    const partial = HELP.split('\n')
      .filter((l) => !new RegExp(`(^|[ ,])${dropped}([ ,]|$)`).test(l))
      .join('\n');
    expect(partial, `the fixture help without ${dropped}`).not.toMatch(new RegExp(`\\s${dropped}\\s`));
    const exec = (help: string) => async (args: string[]) =>
      args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '' }
        : args[0] === 'login'
          ? { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
          : { code: 0, stdout: help, stderr: '' };

    const bad = createCodexAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl')], exec: exec(partial) });
    await expect(bad.preflight(), 'preflight rejects').rejects.toThrow(new RegExp(dropped));
    const out = await drain(bad as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: { CODEX_API_KEY: key() } } });
    expect(out.result.status, 'start is refused').toBe('refused');
    expect(s.prompted(), 'the CLI is never run with a prompt after a failed preflight').toEqual([]);

    const good = createCodexAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl')], exec: exec(HELP) });
    const fp = await good.fingerprint();
    expect(fp.version).toBe('0.167.0');
    expect(fp.help_sha256).toBe(sha256(HELP));
  });

  test('API-key lane: the key reaches the CLI by env only; no key means refused before the CLI runs', async () => {
    const createCodexAdapter = await create();
    const s = stub();
    const a = createCodexAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl'), '--fw-commit'], auth: 'api_key' });
    const none = await drain(a as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: {} } });
    expect(none.result.status, 'no CODEX_API_KEY is refused').toBe('refused');
    expect(
      none.events.some((e: Record<string, unknown>) => e.type === 'error' && /credential_(rejected|missing)/.test(String(e.code))),
      'a typed credential error event',
    ).toBe(true);
    expect(s.prompted(), 'the CLI never ran with a prompt').toEqual([]);

    const k = key();
    const ok = await drain(a as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: { CODEX_API_KEY: k } } });
    expect(ok.result.status, `with CODEX_API_KEY the run completes (summary: ${ok.result.summary})`).toBe('completed');
    const run = s.prompted()[0]!;
    expect(run.env, 'CODEX_API_KEY is in the vendor env').toContain('CODEX_API_KEY');
    expect(run.argv.some((x) => x.includes(k)), 'the key is not in argv').toBe(false);
    expect(JSON.stringify([ok.events, ok.result, ok.meta]), 'the key never leaves the adapter').not.toContain(k);
  });

  test('sign-in lane: runs on the CLI login under CODEX_HOME with no key, refused when signed out', async () => {
    const createCodexAdapter = await create();
    const home = tmpDir('codex-home');
    const s = stub();
    const a = createCodexAdapter({
      command: process.execPath,
      commandArgs: [s.bin, join(FIX, 'success.jsonl'), '--fw-commit'],
      auth: 'signin',
      codexHome: home,
    });
    const out = await drain(a as never, adapterInput({ scenario: 'success' }), { opts: {} });
    expect(out.result.status, 'signed out: refused').toBe('refused');
    expect(s.prompted(), 'signed out: the CLI never ran with a prompt').toEqual([]);

    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), '{"auth_mode":"chatgpt"}\n');
    const ok = await drain(a as never, adapterInput({ scenario: 'success' }), { opts: { credentialEnv: { CODEX_API_KEY: key() } } });
    expect(ok.result.status, `signed in: the run completes (summary: ${ok.result.summary})`).toBe('completed');
    const run = s.prompted()[0]!;
    expect(run.env, 'CODEX_HOME reaches the vendor').toContain('CODEX_HOME');
    expect(run.env, 'no API key is passed in the sign-in lane').not.toContain('CODEX_API_KEY');
  });

  test('vendor fields do not leak; resume works in a two-step test', async () => {
    const createCodexAdapter = await create();
    const s = stub();
    const a = createCodexAdapter({ command: process.execPath, commandArgs: [s.bin, join(FIX, 'success.jsonl'), '--fw-commit'] });
    const opts = { credentialEnv: { CODEX_API_KEY: key() } };
    const ws = adapterInput({ scenario: 'success' });
    const first = await drain(a as never, ws, { opts });
    expect(first.result.status).toBe('completed');
    const blob = JSON.stringify([first.result, first.events]);
    expect(blob.match(VENDOR_NAMES)?.[0] ?? null, 'no Codex event name or id in the run result or events').toBeNull();
    const sid = first.result.session_id as string;
    expect(sid, 'the first run reports a session id').toBeTruthy();

    const input = adapterInput({ scenario: 'success', workspace: ws.workspace.path });
    input.resume_session_id = sid;
    const second = await drain(a as never, input, { opts });
    expect(second.result.status, `the resumed run completes (summary: ${second.result.summary})`).toBe('completed');
    const argv = s.prompted()[1]!.argv;
    const at = argv.indexOf('resume');
    expect(at > argv.indexOf('exec') && argv[at + 1] === sid, `the second run passes exec resume ${sid}: ${argv.join(' ')}`).toBe(true);
    expect(second.result.session_id, 'the resumed run reports the same session').toBe(sid);
  });
});
