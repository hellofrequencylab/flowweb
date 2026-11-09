// Probe c0/adapter-contract-types (WS-P0-026; backlog verify_probe adapters/contract-types).
// Surface: createAdapter from packages/adapters/src/index.ts, and the source tree of the SDK.
// Acceptance:
//   - the interface lives in the adapter SDK (packages/adapters/src/sdk/) with no vendor imports or
//     vendor names
//   - a no-op reference adapter compiles against it: createAdapter('noop') exists, implements the
//     interface, and pnpm typecheck passes (CI)
//   - capabilities declare supports_resume, supports_schema and supports_budget_cap (booleans)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { adapterInput, drain, missing, requireExport, root } from './_lib.mjs';

type Adapter = Record<string, unknown> & { capabilities: () => Record<string, unknown> };

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('c0/adapter-contract-types', () => {
  test('SDK is vendor-blind', () => {
    const sdk = join(root, 'packages/adapters/src/sdk');
    if (!existsSync(sdk)) missing('packages/adapters/src/sdk/ does not exist (adapter SDK, WS-P0-026)');
    for (const f of walk(sdk).filter((p) => /\.(ts|mts|js)$/.test(p))) {
      const text = readFileSync(f, 'utf8');
      expect(/\b(anthropic|openai|claude|codex)\b/i.test(text), `${f} names a vendor`).toBe(false);
      expect(/from\s+['"]\.\.\/(claude|codex|fake)/.test(text), `${f} imports a vendor adapter`).toBe(false);
    }
  });

  test('noop and fake implement the interface and declare capabilities', async () => {
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-026')) as (n: string) => Adapter;
    for (const name of ['noop', 'fake']) {
      const a = createAdapter(name);
      for (const m of ['start', 'kill', 'fingerprint', 'capabilities']) {
        expect(typeof a[m], `${name}.${m} is a function`).toBe('function');
      }
      const caps = a.capabilities();
      for (const c of ['supports_resume', 'supports_schema', 'supports_budget_cap']) {
        expect(typeof caps[c], `${name} capabilities.${c} is a boolean`).toBe('boolean');
      }
    }
    const out = await drain(createAdapter('noop'), adapterInput({ scenario: 'success' }));
    expect(out.result, 'the noop adapter returns a run result').toBeTruthy();
  });
});
