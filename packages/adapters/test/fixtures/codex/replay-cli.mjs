#!/usr/bin/env node
// Stand-in for the `codex` binary in tests: replays a synthetic `codex exec --json` transcript.
// Usage: replay-cli.mjs <fixture.jsonl> [--fw-commit] [--fw-exit=N] [--fw-hang] [--fw-hang-end]
//        [--fw-delay=MS] <codex argv...>
// Answers `--version`, `exec --help`, `login status` like Codex CLI 0.167.0; signed in means
// $CODEX_HOME/auth.json exists. A run needs CODEX_API_KEY in env (never argv) or that sign-in, else
// exits 97. Placeholders: {{THREAD_ID}}, {{SECRET_*}}, {{API_KEY_ECHO}}, assembled at runtime.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [fixture, ...rest] = process.argv.slice(2);
const fw = rest.filter((a) => a.startsWith('--fw-'));
const argv = rest.filter((a) => !a.startsWith('--fw-'));
const codexHome = process.env.CODEX_HOME ?? '';
const signedIn = codexHome !== '' && existsSync(join(codexHome, 'auth.json'));

if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.167.0\n');
  process.exit(0);
}
if (argv[0] === 'exec' && argv.includes('--help')) {
  process.stdout.write(readFileSync(join(here, 'help-exec-0.167.0.txt'), 'utf8'));
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  if (signedIn) {
    process.stdout.write('Logged in using ChatGPT\n');
    process.exit(0);
  }
  process.stderr.write('Not logged in\n');
  process.exit(1);
}

const apiKey = process.env.CODEX_API_KEY ?? '';
if (apiKey && argv.some((a) => a.includes(apiKey))) {
  process.stderr.write('replay: credential found in argv\n');
  process.exit(99);
}
if (argv[0] !== 'exec' || !argv.includes('--json')) {
  process.stderr.write('replay: not invoked as `codex exec --json`\n');
  process.exit(98);
}
if (!apiKey && !signedIn) {
  process.stderr.write('replay: not authenticated (no CODEX_API_KEY, no sign-in under CODEX_HOME)\n');
  process.exit(97);
}
const schemaAt = argv.indexOf('--output-schema');
if (schemaAt < 0 || !existsSync(argv[schemaAt + 1] ?? '')) {
  process.stderr.write('replay: --output-schema <file> missing\n');
  process.exit(96);
}
JSON.parse(readFileSync(argv[schemaAt + 1], 'utf8'));

readFileSync(0, 'utf8'); // the prompt arrives on stdin

const threadId = argv[1] === 'resume' ? argv[2] : randomUUID();
const has = (name) => fw.some((a) => a === name || a.startsWith(`${name}=`));
const val = (name, dflt) => fw.find((a) => a.startsWith(`${name}=`))?.split('=')[1] ?? dflt;
const m = 'FWFAKE';
const subs = {
  '{{THREAD_ID}}': threadId,
  '{{SECRET_OAI}}': ['sk', 'proj', `${m}replay0123456789abcdefgh`].join('-'),
  '{{SECRET_GHP}}': `${'gh'}p_${m}${'x7Y8'.repeat(8)}`,
  '{{SECRET_AWS}}': `${'AK'}IA${m}9876543210`,
  '{{SECRET_PEM}}': `-----BEGIN ${'EC'} PRIVATE KEY-----\\n${m}${'P'.repeat(60)}\\n-----END ${'EC'} PRIVATE KEY-----`,
  '{{API_KEY_ECHO}}': apiKey,
};
const hang = () => {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  return new Promise(() => {});
};
const delay = Number(val('--fw-delay', '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const line0 of readFileSync(fixture, 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)) {
  let line = line0;
  for (const [k, v] of Object.entries(subs)) line = line.split(k).join(v);
  const isEnd = line.startsWith('{"type":"turn.completed"');
  if (isEnd && has('--fw-hang')) await hang();
  if (isEnd && has('--fw-commit')) {
    appendFileSync('replayed-change.txt', `change for ${threadId} at ${Date.now()}\n`);
    const id = ['-c', 'user.name=fw-replay', '-c', 'user.email=replay@fw.invalid'];
    execFileSync('git', [...id, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', [...id, 'commit', '-q', '-m', 'replay change'], { stdio: 'ignore' });
  }
  process.stdout.write(`${line}\n`);
  if (delay) await sleep(delay);
}
if (has('--fw-hang') || has('--fw-hang-end')) await hang();
process.exit(Number(val('--fw-exit', '0')));
