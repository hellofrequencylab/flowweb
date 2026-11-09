#!/usr/bin/env node
// Stand-in for the `claude` binary in tests: replays a synthetic stream-json transcript.
// Usage: replay-cli.mjs <fixture.jsonl> [--fw-commit] [--fw-exit=N] [--fw-hang] [--fw-delay=MS] <claude argv...>
// Placeholders in the fixture: {{SESSION_ID}}, {{SECRET_*}}, {{API_KEY_ECHO}}. Secret-shaped values
// are assembled here at runtime so no fixture file contains one.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [fixture, ...rest] = process.argv.slice(2);

if (rest.includes('--version')) {
  process.stdout.write('2.1.319 (Claude Code)\n');
  process.exit(0);
}
if (rest.includes('--help')) {
  process.stdout.write(readFileSync(join(here, 'help-2.1.319.txt'), 'utf8'));
  process.exit(0);
}

const opt = (name) => rest.find((a) => a === name || a.startsWith(`${name}=`));
const optVal = (name, dflt) => {
  const a = opt(name);
  return a?.includes('=') ? a.split('=')[1] : dflt;
};
const valueAfter = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
if (apiKey && rest.some((a) => a.includes(apiKey))) {
  process.stderr.write('replay: credential found in argv\n');
  process.exit(99);
}
if (!rest.includes('--print') || !rest.includes('stream-json')) {
  process.stderr.write('replay: not invoked in headless stream-json mode\n');
  process.exit(98);
}

readFileSync(0, 'utf8'); // the prompt arrives on stdin

const sessionId = valueAfter('--session-id') ?? valueAfter('--resume') ?? 'replay-session';
const m = 'FWFAKE';
const subs = {
  '{{SESSION_ID}}': sessionId,
  '{{SECRET_ANT}}': ['sk', 'ant', 'api03', `${m}replay0123456789`].join('-'),
  '{{SECRET_GHP}}': `${'gh'}p_${m}${'x7Y8'.repeat(8)}`,
  '{{SECRET_AWS}}': `${'AK'}IA${m}9876543210`,
  '{{SECRET_PEM}}': `-----BEGIN ${'EC'} PRIVATE KEY-----\\n${m}${'P'.repeat(60)}\\n-----END ${'EC'} PRIVATE KEY-----`,
  '{{API_KEY_ECHO}}': apiKey,
};

const delay = Number(optVal('--fw-delay', '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = readFileSync(fixture, 'utf8')
  .split('\n')
  .filter((l) => l.length > 0);

for (const line0 of lines) {
  let line = line0;
  for (const [k, v] of Object.entries(subs)) line = line.split(k).join(v);
  const isResult = line.startsWith('{"type":"result"');
  if (isResult && opt('--fw-hang')) {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (isResult && opt('--fw-commit')) {
    writeFileSync('replayed-change.txt', `change for ${sessionId}\n`);
    const id = ['-c', 'user.name=fw-replay', '-c', 'user.email=replay@fw.invalid'];
    execFileSync('git', [...id, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', [...id, 'commit', '-q', '-m', 'replay change'], { stdio: 'ignore' });
  }
  process.stdout.write(`${line}\n`);
  if (delay) await sleep(delay);
}
if (opt('--fw-hang')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
process.exit(Number(optVal('--fw-exit', '0')));
