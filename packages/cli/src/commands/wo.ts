// fw wo issue
import { EXIT } from '../output.ts';
import type { Command } from './types.ts';

const issue: Command = {
  path: ['wo', 'issue'],
  usage: 'fw wo issue <code> [--doer <agent>] [--verifier <agent>]',
  summary: 'Compile and issue a work order for a ready row (worker doer, separate verifier, size caps)',
  args: ['code'],
  options: ['doer', 'verifier'],
  async run(ctx) {
    const r = await ctx.client.woIssue(ctx.args[0]!, {
      repoDir: ctx.repoDir,
      ...(ctx.opts.doer ? { doer: ctx.opts.doer } : {}),
      ...(ctx.opts.verifier ? { verifier: ctx.opts.verifier } : {}),
    });
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else {
      const caps = Object.entries(r.work_order.budget.caps)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      ctx.io.out(
        `wo issue ${r.code}: issued ${r.work_order_id} v${r.version}; doer ${r.doer}, verifier ${r.verifier}; caps ${caps}; expires ${r.expires_at}`,
      );
    }
    return EXIT.OK;
  },
};

export const woCommands: Command[] = [issue];
