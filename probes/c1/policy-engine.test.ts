// Probe c1/policy-engine (FW-C-009; backlog verify_probe policy/engine).
// Surfaces: the policy engine exported by packages/policy/src/index.ts; the `fw policy check` and
// `fw policy apply` commands; the policy_rules and budgets tables and the policy.rule_changed,
// budget.set and dispatch.refused_policy events of schema.core.sql, read with node:sqlite read-only.
// The exports this probe expects (no spec names them; see probes/c1/README.md, "Decisions" 31-35):
//   loadPolicy(path) -> { rules: [{ id, version, priority, effect, ... }], ... } (core-policy.yaml)
//   decide(policy, { action, role?, environment, context?, work_order_id? })
//     -> { effect, rule_id, rule_version, tier, reason, trail }: rules in priority order (deny wins
//     ties), cap_tier rules narrow the tier and evaluation goes on, the first other effect stops it
//     (trail lists every rule that matched, in order). No stopping rule: the autonomy matrix and the
//     role decide (allow at the lower of the matrix default and the role tier, deny at L0 or when the
//     role may not do the action); nothing else is deny with rule_id null. It never throws: an
//     evaluator error is deny with rule_id null and the error in the reason.
//   enforce(writer, policy, input) -> the same decision; every deny appends one
//     dispatch.refused_policy event (work_order_id, rule_id, rule_version, reason).
// Acceptance (FW-C-009):
//   1. the 12 shipped rules each have a fixture that matches and one that does not
//   2. an evaluator exception returns deny and emits a refusal event with the reason
//   3. fw policy check --action merge_main --env production prints ask, L3 and pol_0120, exits 0
// Description (also probed): fw policy apply compiles rules into policy_rules and budgets into
// budgets as the Owner; inside an agent run (FW_RUN_ID set) it is refused with exit 3.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  count,
  fail,
  fixtureProject,
  freshHome,
  fw,
  fwJson,
  installPolicy,
  openDbReadonly,
  requireExport,
  root,
  storePath,
} from '../c0/_lib.mjs';

type Input = { action: string; role?: string; environment: string; context?: Record<string, unknown> };
type Decision = { effect: string; rule_id: string | null; rule_version?: number; tier?: string; reason: string; trail: string[] };
type Fn = (...a: unknown[]) => unknown;

const ROW = 'FW-C-009';
const POLICY = join(root, 'contracts-core/core-policy.yaml');
const SHIPPED = [
  'pol_0010', 'pol_0020', 'pol_0040', 'pol_0050', 'pol_0060', 'pol_0070',
  'pol_0080', 'pol_0100', 'pol_0115', 'pol_0120', 'pol_0900', 'pol_0920',
];
const RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };

const w = (context: Record<string, unknown>, over: Partial<Input> = {}): Input => ({
  action: 'code_write_sandbox',
  role: 'worker',
  environment: 'sandbox',
  context,
  ...over,
});

/** Per rule: an input it matches (it decides, or for pol_0920 it is on the trail) and one it does not. */
const FIXTURES: Record<string, { hit: Input; miss: Input; effect: string }> = {
  pol_0010: {
    effect: 'deny',
    hit: { action: 'policy_or_gate_change', role: 'worker', environment: 'sandbox' },
    miss: { action: 'policy_or_gate_change', environment: 'sandbox' },
  },
  pol_0020: {
    effect: 'deny',
    hit: w({ tool: 'fs.write', paths: ['probes/c0/skeleton.mjs'] }),
    miss: w({ tool: 'fs.write', paths: ['packages/web/src/app.ts'] }),
  },
  pol_0040: { effect: 'deny', hit: w({ tool: 'git.push_force' }), miss: w({ tool: 'git.push' }) },
  pol_0050: {
    effect: 'deny',
    hit: w({ egress: { host_allowlisted: false } }),
    miss: w({ egress: { host_allowlisted: true } }),
  },
  pol_0060: {
    effect: 'deny',
    hit: { action: 'read_research', role: 'verifier', environment: 'sandbox', context: { tool: 'fs.write', target: { workspace_owner: 'run_other' } } },
    miss: { action: 'read_research', role: 'verifier', environment: 'sandbox', context: { tool: 'fs.write', target: { workspace_owner: 'self' } } },
  },
  pol_0070: {
    effect: 'deny',
    hit: w({ tool: 'agent.spawn' }, { action: 'read_research' }),
    miss: w({ tool: 'agent.spawn' }, { action: 'read_research', role: 'chief_of_staff' }),
  },
  pol_0080: {
    effect: 'deny',
    hit: w({ diff_patterns: ['security_suppression'] }, { action: 'security_remediation' }),
    miss: w({ diff_patterns: [] }, { action: 'security_remediation' }),
  },
  pol_0100: {
    effect: 'escalate',
    hit: w({ risk: { class: 'security' } }),
    miss: w({ risk: { class: 'performance' } }),
  },
  pol_0115: {
    effect: 'require_challenge',
    hit: { action: 'merge_main', environment: 'production', context: { project: { auto_deploys_on_merge: true } } },
    miss: { action: 'merge_main', environment: 'production', context: { project: { auto_deploys_on_merge: false } } },
  },
  pol_0120: {
    effect: 'ask',
    hit: { action: 'merge_main', environment: 'production' },
    miss: w({}),
  },
  pol_0900: {
    effect: 'deny',
    hit: { action: 'deploy_production', role: 'worker', environment: 'production' },
    miss: w({}, { action: 'read_research' }),
  },
  pol_0920: {
    effect: 'cap_tier',
    hit: w({}, { action: 'read_research' }),
    miss: { action: 'policy_or_gate_change', role: 'worker', environment: 'sandbox' },
  },
};

async function engine() {
  const loadPolicy = (await requireExport('policy', 'loadPolicy', ROW)) as Fn;
  const decide = (await requireExport('policy', 'decide', ROW)) as (p: unknown, i: Input) => Decision;
  const enforce = (await requireExport('policy', 'enforce', ROW)) as (w: unknown, p: unknown, i: unknown) => Decision;
  return { loadPolicy, decide, enforce };
}

const say = (i: Input) => JSON.stringify(i);

describe('c1/policy-engine', () => {
  test('acceptance 1: each of the 12 shipped rules has a fixture that matches and one that does not', async () => {
    const { loadPolicy, decide } = await engine();
    const policy = loadPolicy(POLICY) as { rules: { id: string }[] };
    const ids = policy.rules.map((r) => r.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(SHIPPED))
      fail(`loadPolicy(core-policy.yaml).rules are ${ids.join(',')}; expected the 12 shipped rules ${SHIPPED.join(',')}`);

    for (const id of SHIPPED) {
      const f = FIXTURES[id];
      const hit = decide(policy, f.hit);
      if (f.effect === 'cap_tier') {
        if (!hit.trail?.includes(id)) fail(`${id}: decide(${say(f.hit)}) trail ${JSON.stringify(hit.trail)} does not include ${id}`);
        if (hit.effect !== 'allow' || RANK[hit.tier ?? 'L9'] > RANK.L3)
          fail(`${id}: decide(${say(f.hit)}) is ${hit.effect} ${hit.tier}; expected allow at L3 or below`);
      } else if (hit.effect !== f.effect || hit.rule_id !== id) {
        fail(`${id}: decide(${say(f.hit)}) is ${hit.effect} by ${hit.rule_id}; expected ${f.effect} by ${id}`);
      }
      if (hit.rule_id === id && typeof hit.rule_version !== 'number') fail(`${id}: decision carries no rule_version`);
      const miss = decide(policy, f.miss);
      if (miss.rule_id === id || miss.trail?.includes(id))
        fail(`${id}: decide(${say(f.miss)}) still matched ${id} (${miss.effect}, trail ${JSON.stringify(miss.trail)})`);
    }

    // The ask for a merge carries its tier; an action no rule and no matrix entry allows is denied.
    const merge = decide(policy, FIXTURES.pol_0120.hit);
    expect(merge.tier, 'pol_0120 asks at L3').toBe('L3');
    const unmatched = decide(policy, { action: 'tea_making', role: 'worker', environment: 'sandbox' });
    expect(unmatched.effect, 'an unknown action class is denied').toBe('deny');
    expect(unmatched.rule_id, 'an unmatched deny names no rule').toBeNull();
  });

  test('acceptance 2: an evaluator exception is a deny with a refusal event that carries the reason', async () => {
    const { loadPolicy, decide, enforce } = await engine();
    const good = loadPolicy(POLICY) as { rules: Record<string, unknown>[] };
    // A rule whose `matches` condition is not a valid regular expression throws inside the evaluator.
    const broken = {
      ...good,
      rules: [
        { id: 'pol_probe1', version: 1, priority: 1, effect: 'allow', enabled: true, trust_tier: 0,
          reason: 'probe: a rule that breaks the evaluator',
          match: { conditions: [{ field: 'tool', op: 'matches', value: '([' }] } },
        ...good.rules,
      ],
    };
    const input = w({ tool: 'fs.read' }, { action: 'read_research' });
    let d: Decision;
    try {
      d = decide(broken, input);
    } catch (e) {
      fail(`decide threw instead of denying: ${(e as Error).message}`);
    }
    expect(d!.effect, 'an evaluator error is deny').toBe('deny');
    expect(d!.rule_id, 'an evaluator error names no rule').toBeNull();

    const home = freshHome('c1-pol');
    const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);
    const store = openStore({ path: storePath(home), lockPath: join(home, 'fwd.lock') });
    try {
      const refusal = enforce(store.writer, broken, { ...input, work_order_id: 'wo_probepolicy01' });
      expect(refusal.effect).toBe('deny');
      enforce(store.writer, good, { ...w({}, { action: 'read_research' }), work_order_id: 'wo_probepolicy02' });
    } finally {
      store.close();
    }
    const db = await openDbReadonly(home);
    const rows = db
      .prepare("SELECT payload FROM events WHERE type = 'dispatch.refused_policy' ORDER BY seq")
      .all() as { payload: string }[];
    db.close();
    if (rows.length !== 1)
      fail(`expected one dispatch.refused_policy event (the error deny only, not the allow); found ${rows.length}`);
    const p = JSON.parse(rows[0].payload);
    expect(p.work_order_id).toBe('wo_probepolicy01');
    expect(p.rule_id ?? null).toBeNull();
    if (typeof p.reason !== 'string' || !/error/i.test(p.reason) || p.reason !== d!.reason)
      fail(`the refusal event reason ${JSON.stringify(p.reason)} must be the decision's reason and name the error`);
  });

  test('acceptance 3: fw policy check prints ask, L3 and pol_0120 for merge_main in production', () => {
    const home = freshHome('c1-pol-cli');
    const r = fw(['policy', 'check', '--action', 'merge_main', '--env', 'production'], { home, cwd: root });
    if (r.status === 2 && /unknown command/i.test(r.stdout + r.stderr))
      fail('fw policy check is not a command');
    expect(r.status, `fw policy check exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`).toBe(0);
    for (const word of ['ask', 'L3', 'pol_0120'])
      if (!new RegExp(`\\b${word}\\b`).test(r.stdout)) fail(`fw policy check output lacks ${word}: ${r.stdout.slice(0, 300)}`);
    const j = fwJson(['policy', 'check', '--action', 'deploy_production', '--env', 'production', '--role', 'worker'], { home, cwd: root });
    expect(j.status, 'a dry run that denies still exits 0').toBe(0);
    expect([j.json.effect, j.json.rule_id]).toEqual(['deny', 'pol_0900']);
  });

  test('fw policy apply compiles rules and budgets as the Owner, once, and refuses inside a run', async () => {
    const home = installPolicy(freshHome('c1-pol-apply'));
    const proj = fixtureProject({ rowId: 'FW-C-965' });
    const o = { home, cwd: proj.work };
    expect(fw(['ledger', 'sync', '--json'], o).status, 'fw ledger sync on the fixture project').toBe(0);

    const refused = fw(['policy', 'apply', '--json'], { ...o, env: { FW_RUN_ID: 'run_probepolicy01' } });
    expect(refused.status, `fw policy apply inside a run exited ${refused.status}; expected 3`).toBe(3);
    let db = await openDbReadonly(home);
    expect(count(db, 'SELECT count(*) FROM policy_rules'), 'a refused apply writes no rule').toBe(0);
    db.close();

    const applied = fw(['policy', 'apply', '--json'], o);
    expect(applied.status, `fw policy apply exited ${applied.status}: ${(applied.stdout + applied.stderr).slice(0, 300)}`).toBe(0);
    db = await openDbReadonly(home);
    const owner = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'owner'").get() as { value: string }).value);
    const ownerId = typeof owner === 'string' ? owner : owner.id;
    const rules = db.prepare('SELECT id, effect, created_by, rule_hash FROM policy_rules ORDER BY id').all() as Record<string, string>[];
    expect(rules.map((r) => r.id)).toEqual(SHIPPED);
    for (const r of rules) {
      expect(r.created_by, `${r.id} created_by`).toBe(ownerId);
      expect(r.rule_hash, `${r.id} rule_hash`).toMatch(/^[0-9a-f]{64}$/);
    }
    const fleetDay = db.prepare("SELECT max_usd, set_by FROM budgets WHERE scope_kind = 'fleet' AND period = 'day'").get() as Record<string, unknown>;
    const policyText = readFileSync(POLICY, 'utf8');
    const daily = Number(/fleet:\s*\{\s*daily_usd:\s*([0-9.]+)/.exec(policyText)?.[1]);
    expect(fleetDay?.max_usd, 'the fleet daily budget from core-policy.yaml').toBe(daily);
    expect(fleetDay?.set_by).toBe(ownerId);
    const changed = count(db, "SELECT count(*) FROM events WHERE type = 'policy.rule_changed'");
    const budgetSet = count(db, "SELECT count(*) FROM events WHERE type = 'budget.set'");
    expect(changed, 'one policy.rule_changed per compiled rule').toBe(12);
    expect(budgetSet, 'budget.set events').toBeGreaterThan(0);
    db.close();

    expect(fw(['policy', 'apply', '--json'], o).status, 'a second apply').toBe(0);
    db = await openDbReadonly(home);
    expect(count(db, 'SELECT count(*) FROM policy_rules'), 'an unchanged policy adds no rule version').toBe(12);
    expect(count(db, "SELECT count(*) FROM events WHERE type = 'policy.rule_changed'")).toBe(changed);
    expect(count(db, "SELECT count(*) FROM events WHERE type = 'budget.set'")).toBe(budgetSet);
    db.close();
  });
});
