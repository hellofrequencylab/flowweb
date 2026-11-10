import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { decide, loadPolicy, type Policy, type PolicyRule } from '../src/index.ts';

const POLICY = join(import.meta.dirname, '../../../contracts-core/core-policy.yaml');
const base = loadPolicy(POLICY);
const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'priority' | 'effect'>): PolicyRule => ({
  version: 1,
  match: {},
  reason: 'test rule',
  enabled: true,
  trust_tier: 0,
  ...r,
});
const withRules = (...rules: PolicyRule[]): Policy => ({ ...base, rules: [...rules, ...base.rules] });
const worker = { action: 'code_write_sandbox', role: 'worker', environment: 'sandbox' };

describe('policy engine', () => {
  test('deny wins a priority tie', () => {
    const p = withRules(
      rule({ id: 'pol_t001', priority: 5, effect: 'allow' }),
      rule({ id: 'pol_t002', priority: 5, effect: 'deny' }),
    );
    expect(decide(p, worker)).toMatchObject({ effect: 'deny', rule_id: 'pol_t002' });
  });

  test('a cap narrows the tier and evaluation goes on', () => {
    const p = withRules(rule({ id: 'pol_t003', priority: 1, effect: 'cap_tier', cap_tier: 'L1' }));
    const d = decide(p, worker);
    expect(d).toMatchObject({ effect: 'allow', tier: 'L1', source: 'matrix' });
    expect(d.trail).toEqual(['pol_t003', 'pol_0920']);
  });

  test('a disabled rule is skipped', () => {
    const p = withRules(rule({ id: 'pol_t004', priority: 1, effect: 'deny', enabled: false }));
    expect(decide(p, worker).effect).toBe('allow');
  });

  test('numeric conditions compare numbers only', () => {
    const p = withRules(
      rule({
        id: 'pol_t005',
        priority: 1,
        effect: 'escalate',
        match: { conditions: [{ field: 'cost.usd', op: 'gt', value: 5 }] },
      }),
    );
    expect(decide(p, { ...worker, context: { cost: { usd: 6 } } }).rule_id).toBe('pol_t005');
    expect(decide(p, { ...worker, context: { cost: { usd: '6' } } }).rule_id).toBeNull();
  });

  test('a role outside its may list is denied, and production code writes stay at L1', () => {
    expect(decide(base, { ...worker, role: 'verifier' })).toMatchObject({ effect: 'deny', source: 'matrix' });
    expect(decide(base, { ...worker, environment: 'production' })).toMatchObject({
      effect: 'allow',
      tier: 'L1',
    });
  });

  test('an unknown path set is an evaluator error, so a deny', () => {
    const p = withRules(
      rule({ id: 'pol_t006', priority: 1, effect: 'allow', match: { path_globs: '@nope' } }),
    );
    expect(decide(p, { ...worker, context: { paths: ['a.ts'] } })).toMatchObject({
      effect: 'deny',
      source: 'error',
    });
  });
});
