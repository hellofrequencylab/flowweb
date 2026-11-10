// fw policy apply: compiles core-policy.yaml into policy_rules (one version per changed rule, keyed by
// rule_hash) and its budgets block into budgets, as the Owner. Unchanged rules and budgets write
// nothing, so applying twice is a no-op. Each change emits policy.rule_changed or budget.set.
import { canonicalJson, newId, sha256Hex, type Writer } from '@fw/eventlog';
import type { Policy } from './load.ts';

export interface ApplyReport {
  rules_changed: string[];
  rules_unchanged: number;
  budgets_set: string[];
  budgets_unchanged: number;
}

type Caps = { max_usd?: number; max_tokens?: number; max_minutes?: number; max_turns?: number };
interface BudgetSpec {
  scope_kind: string;
  scope_id: string;
  period: string;
  caps: Caps;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function budgetSpecs(w: Writer, b: Record<string, unknown>): BudgetSpec[] {
  const out: BudgetSpec[] = [];
  const periods = [
    ['daily_usd', 'day'],
    ['weekly_usd', 'week'],
    ['monthly_usd', 'month'],
  ] as const;
  const scoped = (kind: string, ids: string[]) => {
    const block = obj(b[kind]);
    for (const id of ids)
      for (const [key, period] of periods) {
        const usd = n(block[key]);
        if (usd !== undefined) out.push({ scope_kind: kind, scope_id: id, period, caps: { max_usd: usd } });
      }
  };
  const ids = (table: string) =>
    w.all<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id);
  scoped('fleet', ['fleet']);
  scoped('project', ids('projects'));
  scoped('stream', ids('streams'));
  scoped('agent', ids('agents'));
  for (const [size, raw] of Object.entries(obj(b.run_by_work_order_size))) {
    const e = obj(raw);
    const caps: Caps = {};
    for (const k of ['max_usd', 'max_tokens', 'max_minutes', 'max_turns'] as const) {
      const v = n(e[k]);
      if (v !== undefined) caps[k] = v;
    }
    if (Object.keys(caps).length)
      out.push({ scope_kind: 'work_order', scope_id: `size:${size}`, period: 'run', caps });
  }
  return out;
}

export function applyPolicy(w: Writer, policy: Policy, ownerId: string): ApplyReport {
  const report: ApplyReport = {
    rules_changed: [],
    rules_unchanged: 0,
    budgets_set: [],
    budgets_unchanged: 0,
  };
  const actor = { actor_kind: 'owner' as const, actor_id: ownerId };
  w.transaction((tx) => {
    for (const rule of policy.rules) {
      const { version: _v, ...content } = rule;
      const hash = sha256Hex(canonicalJson(content));
      const last = tx.get<{ version: number; rule_hash: string }>(
        'SELECT version, rule_hash FROM policy_rules WHERE id = ? ORDER BY version DESC LIMIT 1',
        [rule.id],
      );
      if (last?.rule_hash === hash) {
        report.rules_unchanged++;
        continue;
      }
      const version = last ? Math.max(last.version + 1, rule.version ?? 1) : (rule.version ?? 1);
      tx.run(
        `INSERT INTO policy_rules(id, version, priority, effect, match, tier, cap_tier, reason, enabled, trust_tier, rule_hash, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          rule.id,
          version,
          rule.priority,
          rule.effect,
          canonicalJson(rule.match ?? {}),
          rule.tier ?? null,
          rule.cap_tier ?? null,
          rule.reason,
          rule.enabled === false ? 0 : 1,
          hash,
          ownerId,
        ],
      );
      tx.appendEvent({
        ...actor,
        type: 'policy.rule_changed',
        idempotency_key: `${rule.id}+${version}`,
        payload: {
          rule_id: rule.id,
          from_version: last?.version ?? null,
          to_version: version,
          rule_hash: hash,
          changed_by: [ownerId],
        },
      });
      report.rules_changed.push(rule.id);
    }

    const soft = n(policy.budgets.soft_threshold_pct) ?? 80;
    for (const spec of budgetSpecs(tx, policy.budgets)) {
      const body = canonicalJson(spec.caps);
      const prior = tx.get<{ id: string; version: number; body: string }>(
        'SELECT id, version, body FROM budgets WHERE scope_kind = ? AND scope_id = ? AND period = ?',
        [spec.scope_kind, spec.scope_id, spec.period],
      );
      if (prior?.body === body) {
        report.budgets_unchanged++;
        continue;
      }
      const c = spec.caps;
      const vals = [
        c.max_usd ?? null,
        c.max_tokens ?? null,
        c.max_minutes ?? null,
        c.max_turns ?? null,
        soft,
        body,
      ];
      let id: string;
      let version: number;
      if (prior) {
        ({ id } = prior);
        version = prior.version + 1;
        tx.run(
          'UPDATE budgets SET max_usd = ?, max_tokens = ?, max_minutes = ?, max_turns = ?, soft_threshold_pct = ?, body = ?, version = ?, set_by = ? WHERE id = ?',
          [...vals, version, ownerId, id],
        );
      } else {
        id = newId('bud');
        version = 1;
        tx.run(
          `INSERT INTO budgets(id, scope_kind, scope_id, period, max_usd, max_tokens, max_minutes, max_turns, soft_threshold_pct, body, version, set_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, spec.scope_kind, spec.scope_id, spec.period, ...vals, version, ownerId],
        );
      }
      tx.appendEvent({
        ...actor,
        type: 'budget.set',
        idempotency_key: `${id}+${version}`,
        payload: {
          budget_id: id,
          scope: { kind: spec.scope_kind, id: spec.scope_id, period: spec.period },
          caps: spec.caps,
          set_by: ownerId,
          prior_hash: prior ? sha256Hex(prior.body) : null,
        },
      });
      report.budgets_set.push(id);
    }
  });
  return report;
}
