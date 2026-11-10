// Loads core-policy.yaml into the shape the evaluator reads: the compiled rules, the autonomy matrix,
// the roles, the named path sets rules refer to (@tier0_paths) and the global tier ceiling.
// The file is Tier 0 (Owner-only); this module only reads it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type Tier = (typeof TIERS)[number];
export type Effect = 'allow' | 'deny' | 'ask' | 'escalate' | 'require_challenge' | 'cap_tier';

export interface Condition {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'matches';
  value?: unknown;
}

export interface RuleMatch {
  action_class?: string[];
  environment?: string[];
  agent_role?: string[];
  tool?: string[];
  diff_patterns?: string[];
  path_globs?: string[] | string;
  conditions?: Condition[];
}

export interface PolicyRule {
  id: string;
  version: number;
  priority: number;
  effect: Effect;
  match: RuleMatch;
  tier?: Tier;
  cap_tier?: Tier;
  reason: string;
  enabled: boolean;
  trust_tier: 0;
}

export interface MatrixEntry {
  default: Tier;
  cap: Tier;
}

export interface Policy {
  path: string;
  rules: PolicyRule[];
  /** action class -> environment -> default and cap tier. */
  matrix: Record<string, Record<string, MatrixEntry>>;
  roles: Record<string, { tier: Tier; may: string[] }>;
  /** Named path sets a rule can name as path_globs: '@name'. */
  path_sets: Record<string, string[]>;
  max_global_tier: Tier;
  /** The raw budgets block, compiled by fw policy apply. */
  budgets: Record<string, unknown>;
}

/** Where fwd and the CLI look for the policy, first found wins (same order as the work-order compiler). */
export function policyCandidates(repoDir: string, home?: string): string[] {
  return [
    ...(home ? [join(home, 'config', 'core-policy.yaml')] : []),
    join(repoDir, 'policy', 'core-policy.yaml'),
    join(repoDir, 'contracts-core', 'core-policy.yaml'),
  ];
}

export function findPolicy(repoDir: string, home?: string): string {
  const found = policyCandidates(repoDir, home).find((p) => existsSync(p));
  if (!found)
    throw new Error(`no core-policy.yaml found (looked in ${policyCandidates(repoDir, home).join(', ')})`);
  return found;
}

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function loadPolicy(path: string): Policy {
  const doc = obj(parse(readFileSync(path, 'utf8')));
  const rules = (Array.isArray(doc.rules) ? doc.rules : []).map((r) => obj(r) as unknown as PolicyRule);
  for (const r of rules)
    if (typeof r.id !== 'string' || typeof r.priority !== 'number' || typeof r.effect !== 'string')
      throw new Error(`${path}: rule ${JSON.stringify(r.id)} lacks an id, priority or effect`);

  const matrix: Policy['matrix'] = {};
  for (const [action, raw] of Object.entries(obj(doc.autonomy_matrix))) {
    const envs: Record<string, MatrixEntry> = {};
    for (const [env, v] of Object.entries(obj(raw))) {
      const e = obj(v);
      if (isTier(e.default) && isTier(e.cap)) envs[env] = { default: e.default, cap: e.cap };
    }
    matrix[action] = envs;
  }
  const roles: Policy['roles'] = {};
  for (const [name, raw] of Object.entries(obj(doc.roles))) {
    const r = obj(raw);
    roles[name] = {
      tier: isTier(r.tier) ? r.tier : 'L0',
      may: Array.isArray(r.may) ? r.may.map(String) : [],
    };
  }
  const tier0 = obj(obj(doc.trust_tier_paths).tier0).paths;
  const global = obj(doc.global);
  return {
    path,
    rules,
    matrix,
    roles,
    path_sets: { tier0_paths: Array.isArray(tier0) ? tier0.map(String) : [] },
    max_global_tier: isTier(global.max_global_tier) ? global.max_global_tier : 'L3',
    budgets: obj(doc.budgets),
  };
}
