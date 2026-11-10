// Probe c1/routing (WS-P1-016; backlog verify_probe adapters/routing).
// Surfaces: the router exported by packages/adapters/src/index.ts; the routing table, a data file at
// config/routing.json (and $FW_HOME/config/routing.json, which wins); `fw run start` without
// --adapter or $FW_VENDOR, and its run.queued event, read with node:sqlite read-only.
// The exports this probe expects (no spec names them; see probes/c1/README.md, "Decisions" 36-40):
//   loadRoutingTable(path) -> { version, prefer: [adapter...], adapters: { <name>: { cost_tier,
//     privacy_tier } } }; refuses a table naming an unknown adapter or tier
//   routeAdapter(table, request, { registry?, unavailable? })
//     request: { needs?: capability[], max_cost_tier?: 'low'|'medium'|'high',
//                max_privacy_tier?: 'local'|'vendor_no_training'|'vendor' }
//     registry: [{ name, capabilities }] (default: the real adapters and what each declares)
//     unavailable(name) -> a reason string when the adapter cannot run now, else undefined
//     -> { adapter: name | null, fallback: { from, to, reason } | null, rejected: [{ adapter, reason }] }
//     The first adapter in `prefer` order that passes every check wins; when it is not the first
//     one, fallback names the first one and why it was passed over.
// Acceptance (WS-P1-016):
//   1. an order needing schema output is routed only to adapters declaring it
//   2. a fallback emits route_fallback with its reason (the run.queued event of the run carries
//      route_fallback { from, to, reason })
//   3. the routing table is data (a JSON file read at run time, not code)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  fail,
  fixtureProject,
  fwJson,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  requireExport,
  root,
  tmpDir,
} from '../c0/_lib.mjs';

type Caps = { supports_resume: boolean; supports_schema: boolean; supports_budget_cap: boolean };
type Route = {
  adapter: string | null;
  fallback: { from: string; to: string; reason: string } | null;
  rejected: { adapter: string; reason: string }[];
};
type RouteFn = (table: unknown, request: unknown, opts?: unknown) => Route;

const ROW = 'WS-P1-016';
const caps = (schema: boolean): Caps => ({ supports_resume: false, supports_schema: schema, supports_budget_cap: false });

async function router() {
  const loadRoutingTable = (await requireExport('adapters', 'loadRoutingTable', ROW)) as (p: string) => any;
  const routeAdapter = (await requireExport('adapters', 'routeAdapter', ROW)) as RouteFn;
  return { loadRoutingTable, routeAdapter };
}

describe('c1/routing', () => {
  test('acceptance 3: the routing table is a data file that names real adapters with cost and privacy tiers', async () => {
    const { loadRoutingTable } = await router();
    const { ADAPTER_NAMES } = await import(join(root, 'packages/adapters/src/index.ts'));
    const path = join(root, 'config/routing.json');
    if (!existsSync(path)) fail('config/routing.json does not exist (the routing table)');
    const t = loadRoutingTable(path);
    expect(Array.isArray(t.prefer) && t.prefer.length > 0, 'prefer is a non-empty list').toBe(true);
    for (const name of t.prefer) {
      expect(ADAPTER_NAMES, `${name} is a real adapter`).toContain(name);
      expect(['low', 'medium', 'high']).toContain(t.adapters[name]?.cost_tier);
      expect(['local', 'vendor_no_training', 'vendor']).toContain(t.adapters[name]?.privacy_tier);
    }
    const bad = join(tmpDir('c1-route'), 'routing.json');
    writeFileSync(bad, JSON.stringify({ version: 1, prefer: ['gpt-9'], adapters: { 'gpt-9': { cost_tier: 'low', privacy_tier: 'local' } } }));
    expect(() => loadRoutingTable(bad), 'a table naming an unknown adapter is refused').toThrow();
  });

  test('acceptance 1: an order needing schema output only goes to adapters that declare it', async () => {
    const { routeAdapter } = await router();
    const registry = [
      { name: 'alpha', capabilities: caps(false) },
      { name: 'beta', capabilities: caps(true) },
      { name: 'gamma', capabilities: caps(false) },
      { name: 'delta', capabilities: caps(true) },
    ];
    const tiers = { cost_tier: 'low', privacy_tier: 'local' };
    const adapters = Object.fromEntries(registry.map((r) => [r.name, tiers]));
    const orders = [
      ['alpha', 'beta', 'gamma', 'delta'],
      ['gamma', 'alpha', 'delta', 'beta'],
      ['delta', 'alpha', 'beta', 'gamma'],
      ['alpha', 'gamma', 'beta', 'delta'],
    ];
    for (const prefer of orders) {
      const r = routeAdapter({ version: 1, prefer, adapters }, { needs: ['supports_schema'] }, { registry });
      const first = prefer.find((n) => registry.find((x) => x.name === n)!.capabilities.supports_schema);
      expect(r.adapter, `prefer ${prefer.join(',')}`).toBe(first);
      for (const rej of r.rejected.filter((x) => !registry.find((y) => y.name === x.adapter)!.capabilities.supports_schema))
        expect(rej.reason, 'the rejection names the missing capability').toMatch(/supports_schema/);
      if (prefer[0] !== first) {
        expect(r.fallback?.from).toBe(prefer[0]);
        expect(r.fallback?.to).toBe(first);
        expect(r.fallback?.reason).toMatch(/supports_schema/);
      } else expect(r.fallback).toBeNull();
    }
    const none = routeAdapter(
      { version: 1, prefer: ['alpha', 'gamma'], adapters },
      { needs: ['supports_schema'] },
      { registry },
    );
    expect(none.adapter, 'no adapter declares the capability: nothing is chosen').toBeNull();

    // Cost and privacy tiers narrow the choice the same way.
    const mixed = {
      version: 1,
      prefer: ['beta', 'delta'],
      adapters: { beta: { cost_tier: 'high', privacy_tier: 'vendor' }, delta: { cost_tier: 'low', privacy_tier: 'local' } },
    };
    expect(routeAdapter(mixed, { max_cost_tier: 'medium' }, { registry }).adapter).toBe('delta');
    expect(routeAdapter(mixed, { max_privacy_tier: 'local' }, { registry }).adapter).toBe('delta');
    expect(routeAdapter(mixed, {}, { registry }).adapter).toBe('beta');
    const down = routeAdapter(mixed, {}, { registry, unavailable: (n: string) => (n === 'beta' ? 'probe: beta is down' : undefined) });
    expect([down.adapter, down.fallback?.reason]).toEqual(['delta', expect.stringContaining('probe: beta is down')]);
  });

  test('acceptance 2: fw run start falls back past an adapter with no credential and records route_fallback', async () => {
    await router();
    const proj = fixtureProject({ rowId: 'FW-C-966' });
    const home = pipelineHome('c1-route');
    mkdirSync(join(home, 'config'), { recursive: true });
    // The table prefers claude; this home holds no claude credential, so the run must fall back to fake.
    writeFileSync(
      join(home, 'config/routing.json'),
      JSON.stringify({
        version: 1,
        prefer: ['claude', 'fake'],
        adapters: { claude: { cost_tier: 'high', privacy_tier: 'vendor' }, fake: { cost_tier: 'low', privacy_tier: 'local' } },
      }),
    );
    const { FW_VENDOR: _unset, ...env } = pipelineEnv();
    const o = { home, cwd: proj.work, env };
    expect(fwJson(['ledger', 'sync'], o).status, 'fw ledger sync').toBe(0);
    const run = fwJson(['run', 'start', 'FW-C-966'], o);
    if (run.status !== 0) fail(`fw run start with no adapter named exited ${run.status}: ${run.stdout.slice(0, 300)}`);

    const db = await openDbReadonly(home);
    const runs = db.prepare('SELECT id, adapter_name FROM runs').all() as { id: string; adapter_name: string }[];
    const queued = db.prepare("SELECT payload FROM events WHERE type = 'run.queued'").all() as { payload: string }[];
    db.close();
    expect(runs.map((r) => r.adapter_name), 'the run went to the fallback adapter').toEqual(['fake']);
    expect(queued.length).toBe(1);
    const p = JSON.parse(queued[0]!.payload);
    if (!p.route_fallback) fail(`run.queued carries no route_fallback: ${queued[0]!.payload.slice(0, 300)}`);
    expect(p.route_fallback.from).toBe('claude');
    expect(p.route_fallback.to).toBe('fake');
    expect(p.route_fallback.reason, 'the reason names the missing credential').toMatch(/credential|crd_claude/i);
  });
});
