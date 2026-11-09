// fw audit verify: re-verifies the whole event chain and prints one line.
import { EXIT, short } from '../output.ts';
import type { Command } from './types.ts';

const verify: Command = {
  path: ['audit', 'verify'],
  usage: 'fw audit verify',
  summary: 'Verify the hash chain of the event log (exit 1 on a break)',
  args: [],
  options: [],
  async run(ctx) {
    const v = await ctx.client.auditVerify();
    if (ctx.json) ctx.io.out(JSON.stringify(v));
    else if (v.ok) ctx.io.out(`audit verify: ok, ${v.count} events, head ${short(v.head, 16)}`);
    else
      ctx.io.out(`audit verify: BROKEN at seq ${v.seq}: ${v.reason} (${v.count} events verified before it)`);
    return v.ok ? EXIT.OK : EXIT.FAILED;
  },
};

export const auditCommands: Command[] = [verify];
