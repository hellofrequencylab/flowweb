// Probe c0/adapter-contract-types (WS-P0-026; backlog verify_probe adapters/contract-types).
// Surface: createAdapter and ADAPTER_NAMES from packages/adapters/src/index.ts, the source tree of
// the SDK (packages/adapters/src/sdk/), and contracts-core/json-schema/common.json.
// Acceptance:
//   - the interface lives in the adapter SDK (packages/adapters/src/sdk/) with no vendor imports or
//     vendor names. The one allowed mention is the `Vendor` union, which mirrors the vendor enum of
//     common.json (the SDK types are a stopgap mirror of the contracts, sdk/types.ts header).
//   - a no-op reference adapter compiles against it: createAdapter('noop') exists, implements the
//     interface, and returns a run result (pnpm typecheck is CI)
//   - capabilities declare supports_resume, supports_schema and supports_budget_cap (booleans).
//     In the code `capabilities` is a readonly property of VendorAdapter, not a method.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { adapterInput, drain, requireExport, root } from './_lib.mjs';

type Adapter = Record<string, unknown> & { capabilities: Record<string, unknown> };

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sdk = join(root, 'packages/adapters/src/sdk');
const vendorEnum: string[] = JSON.parse(readFileSync(join(root, 'contracts-core/json-schema/common.json'), 'utf8'))
  .$defs.vendor.enum;
const vendorUnion = `export type Vendor = ${vendorEnum.map((v) => `'${v}'`).join(' | ')};`;

function checkInterface(name: string, a: Adapter) {
  for (const m of ['start', 'fingerprint', 'preflight']) {
    expect(typeof a[m], `${name}.${m} is a function`).toBe('function');
  }
  expect(typeof a.name, `${name}.name`).toBe('string');
  expect(vendorEnum, `${name}.vendor is a common.json vendor`).toContain(a.vendor);
  for (const c of ['supports_resume', 'supports_schema', 'supports_budget_cap']) {
    expect(typeof a.capabilities?.[c], `${name} capabilities.${c} is a boolean`).toBe('boolean');
  }
}

describe('c0/adapter-contract-types', () => {
  test('SDK is vendor-blind', () => {
    const files = walk(sdk).filter((p) => /\.(ts|mts|js|mjs)$/.test(p));
    expect(files.length, 'the SDK has source files').toBeGreaterThan(0);
    expect(readFileSync(join(sdk, 'types.ts'), 'utf8').includes(vendorUnion), 'the Vendor union mirrors common.json').toBe(true);
    for (const f of files) {
      const lines = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== vendorUnion);
      for (const l of lines) {
        expect(/\b(anthropic|openai|claude|codex|gemini)\b/i.test(l), `${f} names a vendor: ${l.trim()}`).toBe(false);
      }
      for (const m of lines.join('\n').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(/^(\.\/|node:)/.test(m[1]), `${f} imports ${m[1]} (only SDK-local and node: imports)`).toBe(true);
      }
    }
  });

  test('every registered adapter implements the interface and declares capabilities', async () => {
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-026')) as (n: string) => Adapter;
    const names = (await requireExport('adapters', 'ADAPTER_NAMES', 'WS-P0-026')) as string[];
    for (const name of names.filter((n) => n !== 'codex')) checkInterface(name, createAdapter(name));
    const out = await drain(createAdapter('fake'), adapterInput({ scenario: 'success' }));
    expect(out.result.status, 'the fake reference adapter returns a run result').toBe('completed');
  });

  test('a no-op reference adapter exists', async () => {
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-026')) as (n: string) => Adapter;
    let noop: Adapter | undefined;
    try {
      noop = createAdapter('noop');
    } catch (e) {
      throw new Error(`createAdapter('noop') fails: ${(e as Error).message} (WS-P0-026 names a no-op reference adapter)`);
    }
    checkInterface('noop', noop);
    const out = await drain(noop, adapterInput({ scenario: 'success' }));
    expect(out.result, 'the noop adapter returns a run result').toBeTruthy();
  });
});
