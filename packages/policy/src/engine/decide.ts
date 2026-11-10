// The policy evaluator: deterministic, deny-overrides, and a failure is a deny.
// Rules run lowest priority first (deny wins a tie). A cap_tier rule narrows the tier and evaluation
// goes on; any other effect stops it. When no rule stops it, the autonomy matrix and the role decide:
// allow at the lower of the matrix default and the role's tier, deny at L0 or when the role may not do
// the action. An action neither covers is unmatched: deny, rule_id null. decide() never throws.
// enforce() is decide() plus the log: every deny appends one dispatch.refused_policy event.
import type { Writer } from '@fw/eventlog';
import { globToRegExp } from '../diff-policy.ts';
import { type Condition, type Effect, type Policy, type PolicyRule, TIERS, type Tier } from './load.ts';

export interface DecisionInput {
  action: string;
  role?: string;
  environment: string;
  /** tool, paths, diff_patterns, and the objects rule conditions read (egress, risk, project, target). */
  context?: Record<string, unknown>;
  work_order_id?: string;
}

export interface Decision {
  effect: Exclude<Effect, 'cap_tier'>;
  /** The rule that decided; null when the matrix decided, nothing matched, or the evaluator failed. */
  rule_id: string | null;
  rule_version: number | null;
  tier: Tier | null;
  reason: string;
  source: 'rule' | 'matrix' | 'unmatched' | 'error';
  /** Every rule that matched, in evaluation order. */
  trail: string[];
}

const rank = (t: Tier) => TIERS.indexOf(t);
const lowest = (...ts: (Tier | undefined)[]): Tier =>
  ts.filter((t): t is Tier => !!t).reduce((a, b) => (rank(b) < rank(a) ? b : a));

function field(ctx: Record<string, unknown>, path: string): unknown {
  let v: unknown = ctx;
  for (const k of path.split('.'))
    v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

function holds(c: Condition, ctx: Record<string, unknown>): boolean {
  const v = field(ctx, c.field);
  const num = typeof v === 'number' && typeof c.value === 'number';
  switch (c.op) {
    case 'eq':
      return v === c.value;
    case 'neq':
      return v !== c.value;
    case 'gt':
      return num && (v as number) > (c.value as number);
    case 'gte':
      return num && (v as number) >= (c.value as number);
    case 'lt':
      return num && (v as number) < (c.value as number);
    case 'lte':
      return num && (v as number) <= (c.value as number);
    case 'in':
      return Array.isArray(c.value) && c.value.includes(v);
    case 'not_in':
      return Array.isArray(c.value) && !c.value.includes(v);
    case 'matches':
      return typeof v === 'string' && new RegExp(String(c.value)).test(v);
    default:
      throw new Error(`unknown condition op ${JSON.stringify((c as { op: unknown }).op)} on ${c.field}`);
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
const inList = (list: string[] | undefined, v: unknown) =>
  list === undefined || (typeof v === 'string' && list.includes(v));

function matches(rule: PolicyRule, input: DecisionInput, policy: Policy): boolean {
  const m = rule.match ?? {};
  const ctx = input.context ?? {};
  if (!inList(m.action_class, input.action)) return false;
  if (!inList(m.environment, input.environment)) return false;
  if (!inList(m.agent_role, input.role)) return false;
  if (!inList(m.tool, ctx.tool)) return false;
  if (m.diff_patterns && !strings(ctx.diff_patterns).some((p) => m.diff_patterns!.includes(p))) return false;
  if (m.path_globs !== undefined) {
    let globs: string[];
    if (typeof m.path_globs === 'string') {
      const set = policy.path_sets[m.path_globs.slice(1)];
      if (!set) throw new Error(`${rule.id} names an unknown path set ${m.path_globs}`);
      globs = set;
    } else globs = m.path_globs;
    const res = globs.map((g) => globToRegExp(g));
    if (!strings(ctx.paths).some((p) => res.some((re) => re.test(p)))) return false;
  }
  return (m.conditions ?? []).every((c) => holds(c, ctx));
}

function evaluate(policy: Policy, input: DecisionInput): Decision {
  const order = { deny: 0 } as Record<string, number>;
  const rules = policy.rules
    .filter((r) => r.enabled !== false)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (order[a.effect] ?? 1) - (order[b.effect] ?? 1) ||
        a.id.localeCompare(b.id),
    );
  const trail: string[] = [];
  const caps: Tier[] = [policy.max_global_tier];
  for (const rule of rules) {
    if (!matches(rule, input, policy)) continue;
    trail.push(rule.id);
    if (rule.effect === 'cap_tier') {
      if (rule.cap_tier) caps.push(rule.cap_tier);
      continue;
    }
    const tier = rule.tier ? lowest(rule.tier, ...caps) : null;
    return {
      effect: rule.effect,
      rule_id: rule.id,
      rule_version: rule.version ?? 1,
      tier,
      reason: rule.reason,
      source: 'rule',
      trail,
    };
  }
  const deny = (source: Decision['source'], reason: string): Decision => ({
    effect: 'deny',
    rule_id: null,
    rule_version: null,
    tier: null,
    reason,
    source,
    trail,
  });
  const entry = policy.matrix[input.action]?.[input.environment];
  if (!entry)
    return deny(
      'unmatched',
      `unmatched: no rule or autonomy matrix entry for ${input.action} in ${input.environment}`,
    );
  const role = input.role === undefined ? undefined : policy.roles[input.role];
  if (input.role !== undefined && !role?.may.includes(input.action))
    return deny('matrix', `role ${input.role} may not ${input.action}`);
  const tier = lowest(entry.default, entry.cap, role?.tier, ...caps);
  if (tier === 'L0')
    return deny('matrix', `${input.action} in ${input.environment} is L0: not allowed in Core`);
  return {
    effect: 'allow',
    rule_id: null,
    rule_version: null,
    tier,
    reason: `autonomy matrix: ${input.action} in ${input.environment} at ${tier}`,
    source: 'matrix',
    trail,
  };
}

/** Decides one request. Never throws: an evaluator error is a deny with the error in the reason. */
export function decide(policy: Policy, input: DecisionInput): Decision {
  try {
    return evaluate(policy, input);
  } catch (e) {
    return {
      effect: 'deny',
      rule_id: null,
      rule_version: null,
      tier: null,
      reason: `policy evaluator error: ${e instanceof Error ? e.message : String(e)}`,
      source: 'error',
      trail: [],
    };
  }
}

/** decide(), and every deny is logged as one dispatch.refused_policy event. */
export function enforce(w: Writer, policy: Policy, input: DecisionInput): Decision {
  const d = decide(policy, input);
  if (d.effect === 'deny')
    w.appendEvent({
      type: 'dispatch.refused_policy',
      actor_kind: 'system',
      actor_id: 'policy.engine',
      payload: {
        work_order_id: input.work_order_id ?? null,
        rule_id: d.rule_id,
        rule_version: d.rule_version,
        reason: d.reason,
        action: input.action,
        environment: input.environment,
      },
    });
  return d;
}
