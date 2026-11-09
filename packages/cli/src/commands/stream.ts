// fw stream add -f <file> [--approval <apr_id>]: store a stream definition (stream-definition.json).
// A definition without a budget is refused (exit 1); a default tier above L2 without a recorded
// Owner approval is refused by policy (exit 3). Nothing is written on a refusal.
// fw stream list: every stored stream.
import { readFileSync } from 'node:fs';
import { EXIT, short, table } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

function unsupported(): never {
  throw new UnsupportedError(
    'the core client in use does not serve streams; the ledger package provides them',
  );
}

const add: Command = {
  path: ['stream', 'add'],
  usage: 'fw stream add -f <file> [--approval <apr_id>]',
  summary: 'Add a stream from a definition file; needs a budget, and an approval above tier L2',
  args: [],
  options: ['file', 'approval'],
  required: ['file'],
  async run(ctx) {
    const file = ctx.opts.file!;
    let definition: unknown;
    try {
      definition = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw fail('INVALID_DEFINITION', `cannot read ${file} as JSON: ${(e as Error).message}`);
    }
    if (typeof ctx.client.streamAdd !== 'function') unsupported();
    const approvalId = ctx.opts.approval;
    const report = await ctx.client.streamAdd(definition, approvalId ? { approvalId } : {});
    if (ctx.json) ctx.io.out(JSON.stringify(report, null, 2));
    else {
      const s = report.stream;
      ctx.io.out(
        `added stream ${s.id} (${s.key}) in ${s.project_id}: tier ${s.default_tier}, status ${s.status}`,
      );
      ctx.io.out(`definition ${short(s.definition_hash)}, event #${report.event_seq}`);
    }
    return EXIT.OK;
  },
};

const list: Command = {
  path: ['stream', 'list'],
  usage: 'fw stream list',
  summary: 'List the stored streams',
  args: [],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.streamList !== 'function') unsupported();
    const streams = await ctx.client.streamList();
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ streams }, null, 2));
      return EXIT.OK;
    }
    if (!streams.length) {
      ctx.io.out('no streams');
      return EXIT.OK;
    }
    ctx.io.out(
      table([
        ['ID', 'PROJECT', 'KEY', 'TIER', 'STATUS', 'TRIGGER', 'BUDGET'],
        ...streams.map((s) => [
          s.id,
          s.project_id,
          s.key,
          s.default_tier,
          s.status,
          s.trigger,
          `${Object.entries(s.budget.caps)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')}/${s.budget.period}`,
        ]),
      ]),
    );
    return EXIT.OK;
  },
};

export const streamCommands: Command[] = [add, list];
