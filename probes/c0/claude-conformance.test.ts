// Probe c0/claude-conformance (WS-P0-030; backlog verify_probe adapters/claude-conformance).
// Surface: createAdapter('claude', { bin, credential }) and runConformance from
// packages/adapters/src/index.ts. Offline, `bin` points at a stub CLI written by this probe, so no
// vendor flag is hardcoded here: the stub's --help is either empty (preflight must fail closed) or a
// copy of the help text the adapter itself declares it needs (adapter.requiredFlags()).
// Acceptance:
//   - preflight fails closed when a required flag is missing from --help (the stub is never run
//     with a prompt), and the fingerprint is the CLI version plus sha256 of the help text
//   - the adapter refuses to start if the credential kind is not api_key
//   - with FW_LIVE_VENDORS=1: the conformance suite passes against the real CLI, including session
//     id stored and resumed (skipped, not failed, otherwise). The recorded-CLI fixture variant is
//     not checked offline; see probes/c0/README.md.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { adapterInput, drain, requireExport, sha256, tmpDir } from './_lib.mjs';

type Adapter = {
  start: (i: unknown) => AsyncIterable<Record<string, unknown>>;
  kill: () => void;
  fingerprint: () => Promise<{ version: string; help_sha256: string }>;
  requiredFlags?: () => string[];
};
type CreateAdapter = (name: string, o?: Record<string, unknown>) => Adapter;

function stub(help: string, version = 'stub-cli 9.9.9') {
  const dir = tmpDir('claude-stub');
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
if (a.includes('--help') || a.includes('-h')) { process.stdout.write(${JSON.stringify(help)}); process.exit(0); }
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 'stub-session-1' }));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, version };
}

const calls = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
    : [];

describe('c0/claude-conformance', () => {
  test('preflight fails closed on missing flags; fingerprint is version + sha256(help)', async () => {
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-030')) as CreateAdapter;
    const empty = stub('');
    const a = createAdapter('claude', { bin: empty.bin, credential: { kind: 'api_key', handle: 'crd_probe0001' } });
    let refused = false;
    try {
      const out = await drain(a, adapterInput({ scenario: 'success' }), { timeoutMs: 20000 });
      refused = out.result?.status === 'refused';
    } catch {
      refused = true;
    }
    expect(refused, 'start is refused when --help lacks the required flags').toBe(true);
    const prompted = calls(empty.log).filter((c) => !c.includes('--help') && !c.includes('--version'));
    expect(prompted, 'the CLI is never run with a prompt after a failed preflight').toEqual([]);

    expect(typeof a.requiredFlags, 'the adapter declares the flags its preflight requires').toBe('function');
    const flags = a.requiredFlags!();
    const helpText = `Usage: stub [options]\n${flags.map((f) => `  ${f}  described\n`).join('')}`;
    const full = stub(helpText, 'stub-cli 1.2.3');
    const b = createAdapter('claude', { bin: full.bin, credential: { kind: 'api_key', handle: 'crd_probe0001' } });
    const fp = await b.fingerprint();
    expect(fp.version).toContain('1.2.3');
    expect(fp.help_sha256).toBe(sha256(helpText));
  });

  test('a credential that is not api_key is refused before anything runs', async () => {
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-030')) as CreateAdapter;
    const s = stub('');
    let refused = false;
    try {
      const a = createAdapter('claude', { bin: s.bin, credential: { kind: 'subscription', handle: 'crd_probe0002' } });
      const out = await drain(a, adapterInput({ scenario: 'success' }), { timeoutMs: 20000 });
      refused = out.result?.status === 'refused';
    } catch {
      refused = true;
    }
    expect(refused, 'non api_key credential refused').toBe(true);
    expect(calls(s.log).filter((c) => !c.includes('--help') && !c.includes('--version'))).toEqual([]);
  });

  test.skipIf(process.env.FW_LIVE_VENDORS !== '1')('live: conformance suite passes against claude', async () => {
    const runConformance = (await requireExport('adapters', 'runConformance', 'WS-P0-030')) as (
      a: unknown,
    ) => Promise<{ case: string; ok: boolean }[]>;
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-030')) as CreateAdapter;
    const failed = (await runConformance(createAdapter('claude'))).filter((r) => !r.ok);
    expect(failed).toEqual([]);
  }, 900_000);
});
