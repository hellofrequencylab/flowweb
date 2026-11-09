// The parts of core-policy.yaml the work-order compiler reads: the per-size run caps and work-order
// TTLs, the diff size caps and the Tier 0 paths. The file is Tier 0 and is only read here.
// Lookup order: $FW_HOME/config/core-policy.yaml (the installed copy), <repo>/policy/core-policy.yaml,
// <repo>/contracts-core/core-policy.yaml.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetCaps, Size } from '@fw/contracts';
import { parse } from 'yaml';
import { LedgerError } from './errors.ts';

export interface SizeRule {
  /** Undefined when the size is not dispatchable (no caps in the table). */
  caps?: BudgetCaps;
  ttl_hours?: number;
  note?: string;
}

export interface CorePolicy {
  path: string;
  sizes: Partial<Record<Size, SizeRule>>;
  max_diff_lines: number;
  max_files: number;
  tier0_paths: string[];
}

export function policyCandidates(repoDir: string, home?: string): string[] {
  return [
    ...(home ? [join(home, 'config', 'core-policy.yaml')] : []),
    join(repoDir, 'policy', 'core-policy.yaml'),
    join(repoDir, 'contracts-core', 'core-policy.yaml'),
  ];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function loadCorePolicy(repoDir: string, home?: string): CorePolicy {
  const path = policyCandidates(repoDir, home).find((p) => existsSync(p));
  if (!path)
    throw new LedgerError(
      'POLICY_MISSING',
      `no core-policy.yaml found (looked in ${policyCandidates(repoDir, home).join(', ')})`,
    );
  const doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const budgets = (doc.budgets ?? {}) as Record<string, unknown>;
  const table = (budgets.run_by_work_order_size ?? {}) as Record<string, Record<string, unknown>>;
  const ttl = (budgets.work_order_ttl_hours ?? {}) as Record<string, unknown>;
  const sizes: Partial<Record<Size, SizeRule>> = {};
  for (const size of ['XS', 'S', 'M', 'L', 'XL'] as const) {
    const entry = table[size];
    if (!entry) continue;
    const caps: BudgetCaps = {};
    for (const k of ['max_usd', 'max_tokens', 'max_minutes', 'max_turns'] as const) {
      const v = num(entry[k]);
      if (v !== undefined) caps[k] = v;
    }
    const rule: SizeRule = {};
    if (Object.keys(caps).length) rule.caps = caps;
    const t = num(ttl[size]);
    if (t !== undefined) rule.ttl_hours = t;
    if (typeof entry.note === 'string') rule.note = entry.note;
    sizes[size] = rule;
  }
  const diff = ((doc.diff_policy as Record<string, unknown> | undefined)?.size_caps ?? {}) as Record<
    string,
    unknown
  >;
  const tiers = (doc.trust_tier_paths ?? {}) as Record<string, { paths?: unknown }>;
  const tier0 = Array.isArray(tiers.tier0?.paths) ? (tiers.tier0.paths as unknown[]).map(String) : [];
  return {
    path,
    sizes,
    max_diff_lines: num(diff.default_max_changed_lines) ?? 400,
    max_files: num(diff.default_max_files) ?? 15,
    tier0_paths: tier0,
  };
}
