// fw policy check: a dry run of the policy engine for one action, role and environment. It reads the
// policy file only and exits 0 whatever the decision. fw policy apply: compiles core-policy.yaml into
// the policy_rules and budgets tables as the Owner; refused (exit 3) inside an agent run.
import { EXIT } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}
const unsupported = (): never => {
  throw new UnsupportedError(
    'the core client in use does not serve the policy engine; the daemon package provides it',
  );
};
class BadArgument extends Error {
  readonly code = 'BAD_ARGUMENT';
}

const check: Command = {
  path: ['policy', 'check'],
  usage: 'fw policy check [--role <role>] [--context <json>] --action <class> --env <environment>',
  summary: 'Dry-run the policy engine: print the effect, tier and deciding rule (always exit 0)',
  args: [],
  options: ['action', 'env', 'role', 'context'],
  required: ['action', 'env'],
  async run(ctx) {
    if (typeof ctx.client.policyCheck !== 'function') unsupported();
    let context: Record<string, unknown> | undefined;
    if (ctx.opts.context !== undefined) {
      try {
        context = JSON.parse(ctx.opts.context) as Record<string, unknown>;
      } catch {
        throw new BadArgument('--context must be a JSON object');
      }
    }
    const d = await ctx.client.policyCheck!({
      action: ctx.opts.action!,
      environment: ctx.opts.env!,
      ...(ctx.opts.role !== undefined ? { role: ctx.opts.role } : {}),
      ...(context ? { context } : {}),
    });
    if (ctx.json) ctx.io.out(JSON.stringify(d, null, 2));
    else {
      const by = d.rule_id ? `${d.rule_id} v${d.rule_version}` : d.source;
      ctx.io.out(`${d.effect}${d.tier ? ` at ${d.tier}` : ''} by ${by}: ${d.reason}`);
      if (d.trail.length) ctx.io.out(`rules matched: ${d.trail.join(', ')}`);
    }
    return EXIT.OK;
  },
};

const apply: Command = {
  path: ['policy', 'apply'],
  usage: 'fw policy apply',
  summary: 'Compile core-policy.yaml into policy rules and budgets (Owner only)',
  args: [],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.policyApply !== 'function') unsupported();
    const r = await ctx.client.policyApply!();
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else
      ctx.io.out(
        `applied ${r.policy_path}: ${r.rules_changed.length} rule(s) changed, ${r.rules_unchanged} unchanged; ` +
          `${r.budgets_set.length} budget(s) set, ${r.budgets_unchanged} unchanged`,
      );
    return EXIT.OK;
  },
};

export const policyCommands: Command[] = [check, apply];
