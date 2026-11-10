import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { adapterRegistry, loadRoutingTable, routeAdapter } from '../src/index.ts';

const TABLE = join(import.meta.dirname, '../../../config/routing.json');

function write(t: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), 'fw-route-')), 'routing.json');
  writeFileSync(p, JSON.stringify(t));
  return p;
}

describe('adapter routing', () => {
  test('the shipped table loads and prefers adapters that declare schema output', () => {
    const t = loadRoutingTable(TABLE);
    const r = routeAdapter(t, { needs: ['supports_schema'] });
    expect(r.adapter).toBe(t.prefer[0]);
    expect(r.fallback).toBeNull();
  });

  test('a table with a bad tier or an empty prefer list is refused', () => {
    expect(() => loadRoutingTable(write({ version: 1, prefer: [], adapters: {} }))).toThrow(/non-empty/);
    expect(() =>
      loadRoutingTable(
        write({
          version: 1,
          prefer: ['fake'],
          adapters: { fake: { cost_tier: 'free', privacy_tier: 'local' } },
        }),
      ),
    ).toThrow(/cost_tier/);
  });

  test('an adapter named in prefer but not registered is passed over with a reason', () => {
    const t = {
      version: 1,
      prefer: ['ghost', 'fake'],
      adapters: { fake: { cost_tier: 'low' as const, privacy_tier: 'local' as const } },
    };
    const r = routeAdapter(t, {}, { registry: adapterRegistry() });
    expect(r.adapter).toBe('fake');
    expect(r.fallback).toEqual({ from: 'ghost', to: 'fake', reason: 'ghost is not a registered adapter' });
  });
});
