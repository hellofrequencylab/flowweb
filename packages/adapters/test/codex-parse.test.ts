import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CODEX_REQUIRED_FLAGS, verifyCodexFlags } from '../src/codex/flags.ts';
import { createCodexParser } from '../src/codex/parse.ts';
import type { VendorItem } from '../src/index.ts';
import { FIXTURES } from './helpers.ts';

const DIR = join(FIXTURES, 'codex');
const HELP = readFileSync(join(DIR, 'help-exec-0.167.0.txt'), 'utf8');
const TID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';

function parseFixture(name: string): VendorItem[] {
  const parse = createCodexParser();
  return readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .flatMap((l) => parse(l.split('{{THREAD_ID}}').join(TID)));
}

describe('codex exec flags', () => {
  test('the recorded help text verifies every required flag, --model and resume', () => {
    const verified = verifyCodexFlags(HELP);
    for (const r of CODEX_REQUIRED_FLAGS) expect(verified).toContain(r.flag);
    expect(verified).toEqual(expect.arrayContaining(['--model', '--ignore-user-config', 'resume']));
  });

  test('a help text without --json fails closed', () => {
    expect(() => verifyCodexFlags(HELP.replace(/--json/g, '--jsonl'))).toThrow(/--json/);
  });
});

describe('codex parser', () => {
  test('a success transcript maps to session, tool calls, turns and one result', () => {
    const items = parseFixture('success.jsonl');
    expect(items[0]).toEqual({ kind: 'session', session_id: TID });
    expect(items.filter((i) => i.kind === 'tool_call').map((i) => (i as { name: string }).name)).toEqual([
      'shell',
      'apply_patch',
    ]);
    expect(items.filter((i) => i.kind === 'tool_result')).toHaveLength(2);
    const result = items.find((i) => i.kind === 'result') as Extract<VendorItem, { kind: 'result' }>;
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe(TID);
    expect(result.usage).toEqual({ input_tokens: 6000, output_tokens: 900, cached_tokens: 18000 });
    expect((result.report as { summary: string }).summary).toMatch(/Debounced/);
  });
  test('retry notices are not errors; turn.failed is a failed result', () => {
    const items = parseFixture('failed.jsonl');
    expect(items.some((i) => i.kind === 'error')).toBe(false);
    expect(items.at(-1)).toMatchObject({
      kind: 'result',
      ok: false,
      subtype: 'turn_failed',
      summary: expect.stringMatching(/401/),
    });
  });
  test('malformed lines become typed errors and unknown events are ignored', () => {
    const codes = parseFixture('malformed.jsonl')
      .filter((i) => i.kind === 'error')
      .map((i) => (i as { code: string }).code);
    expect(codes).toEqual(['malformed_line', 'unexpected_shape', 'unexpected_shape']);
  });
});
