// Adapter routing: pick an adapter for a work order by the capabilities it needs, a cost tier and a
// privacy tier. The routing table is data (config/routing.json, or $FW_HOME/config/routing.json);
// what each adapter can do is what the adapter itself declares, never table data. The first adapter
// in the table's `prefer` order that passes every check wins. When that is not the first preference,
// the route carries a fallback naming the first one and why it was passed over; the caller records it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterCapabilities } from './types.ts';

export const COST_TIERS = ['low', 'medium', 'high'] as const;
export const PRIVACY_TIERS = ['local', 'vendor_no_training', 'vendor'] as const;
export type CostTier = (typeof COST_TIERS)[number];
export type PrivacyTier = (typeof PRIVACY_TIERS)[number];
export type Capability = keyof AdapterCapabilities;

export interface RoutingTable {
  version: number;
  prefer: string[];
  adapters: Record<string, { cost_tier: CostTier; privacy_tier: PrivacyTier }>;
}

export interface RouteRequest {
  needs?: Capability[];
  max_cost_tier?: CostTier;
  max_privacy_tier?: PrivacyTier;
}

export interface RouteOptions {
  /** The adapters and what each declares. */
  registry: readonly { name: string; capabilities: AdapterCapabilities }[];
  /** A reason when the adapter cannot run now (for example a missing credential), else undefined. */
  unavailable?: (name: string) => string | undefined;
}

export interface Route {
  adapter: string | null;
  fallback: { from: string; to: string; reason: string } | null;
  rejected: { adapter: string; reason: string }[];
}

/** Where fw run start looks for the table, first found wins. */
export function routingTableCandidates(repoDir: string, home?: string): string[] {
  return [...(home ? [join(home, 'config', 'routing.json')] : []), join(repoDir, 'config', 'routing.json')];
}

export function findRoutingTable(repoDir: string, home?: string): string | undefined {
  return routingTableCandidates(repoDir, home).find((p) => existsSync(p));
}

/** Reads and checks a routing table; `known` lists the adapter names it may use. */
export function parseRoutingTable(path: string, known: readonly string[]): RoutingTable {
  const t = JSON.parse(readFileSync(path, 'utf8')) as Partial<RoutingTable>;
  const bad = (why: string): never => {
    throw new Error(`routing table ${path}: ${why}`);
  };
  if (!Array.isArray(t.prefer) || t.prefer.length === 0) bad('prefer must be a non-empty list of adapters');
  if (!t.adapters || typeof t.adapters !== 'object') bad('adapters must map each adapter to its tiers');
  for (const name of t.prefer!) {
    if (!known.includes(name)) bad(`unknown adapter ${JSON.stringify(name)} (known: ${known.join(', ')})`);
    const a = t.adapters![name];
    if (!a || !(COST_TIERS as readonly string[]).includes(a.cost_tier))
      bad(`${name}: cost_tier must be one of ${COST_TIERS.join(', ')}`);
    if (!(PRIVACY_TIERS as readonly string[]).includes(a!.privacy_tier))
      bad(`${name}: privacy_tier must be one of ${PRIVACY_TIERS.join(', ')}`);
  }
  return { version: typeof t.version === 'number' ? t.version : 1, prefer: t.prefer!, adapters: t.adapters! };
}

function rejection(
  name: string,
  table: RoutingTable,
  req: RouteRequest,
  opts: RouteOptions,
): string | undefined {
  const entry = opts.registry.find((r) => r.name === name);
  if (!entry) return `${name} is not a registered adapter`;
  const missing = (req.needs ?? []).filter((c) => !entry.capabilities[c]);
  if (missing.length) return `${name} does not declare ${missing.join(', ')}`;
  const tiers = table.adapters[name];
  if (!tiers) return `${name} has no tiers in the routing table`;
  if (req.max_cost_tier && COST_TIERS.indexOf(tiers.cost_tier) > COST_TIERS.indexOf(req.max_cost_tier))
    return `${name} costs ${tiers.cost_tier}, above ${req.max_cost_tier}`;
  if (
    req.max_privacy_tier &&
    PRIVACY_TIERS.indexOf(tiers.privacy_tier) > PRIVACY_TIERS.indexOf(req.max_privacy_tier)
  )
    return `${name} is ${tiers.privacy_tier}, beyond ${req.max_privacy_tier}`;
  return opts.unavailable?.(name);
}

export function routeWith(table: RoutingTable, req: RouteRequest, opts: RouteOptions): Route {
  const rejected: Route['rejected'] = [];
  for (const name of table.prefer) {
    const reason = rejection(name, table, req, opts);
    if (reason !== undefined) {
      rejected.push({ adapter: name, reason });
      continue;
    }
    const first = rejected[0];
    return {
      adapter: name,
      fallback: first ? { from: first.adapter, to: name, reason: first.reason } : null,
      rejected,
    };
  }
  return { adapter: null, fallback: null, rejected };
}
