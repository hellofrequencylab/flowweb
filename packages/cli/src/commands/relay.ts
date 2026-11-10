// fw relay (WS-P1-028, relay R0/R1): for an agent that cannot be driven headlessly. `prompt` prints the
// exact text to paste for a work order and records it as owed; `owed` lists owed prompts and raises the old
// ones for review; `result` takes the agent's pasted reply, checks it against run-result.json and stores it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, table } from '../output.ts';
import type { Command, CommandContext } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}
class UsageError extends Error {
  readonly code = 'USAGE';
}

function need<K extends 'relayPrompt' | 'relayOwed' | 'relayResult'>(ctx: CommandContext, k: K) {
  const fn = ctx.client[k];
  if (typeof fn !== 'function')
    throw new UnsupportedError(
      'the core client in use does not serve the relay; the daemon package provides it',
    );
  return fn.bind(ctx.client) as NonNullable<CommandContext['client'][K]>;
}

const prompt: Command = {
  path: ['relay', 'prompt'],
  usage: 'fw relay prompt <order>',
  summary: 'Print the paste-ready prompt for a work order (id or row code) and record it as owed',
  args: ['order'],
  options: [],
  async run(ctx) {
    const r = await need(ctx, 'relayPrompt')(ctx.args[0]!);
    ctx.io.out(ctx.json ? JSON.stringify(r, null, 2) : r.prompt);
    return EXIT.OK;
  },
};

const owed: Command = {
  path: ['relay', 'owed'],
  usage: 'fw relay owed [--older-than-hours <n>]',
  summary: 'List prompts owed back by relay agents; older ones become review items',
  args: [],
  options: ['older-than-hours'],
  async run(ctx) {
    const raw = ctx.opts['older-than-hours'];
    const hours = raw === undefined ? undefined : Number(raw);
    if (hours !== undefined && !(Number.isFinite(hours) && hours >= 0))
      throw new UsageError(`--older-than-hours takes a number of hours, not ${String(raw)}`);
    const r = await need(ctx, 'relayOwed')(hours === undefined ? {} : { olderThanHours: hours });
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else if (!r.owed.length) ctx.io.out('no prompts are owed');
    else {
      const review = new Set(r.review_items.map((x) => x.run_id));
      ctx.io.out(
        table([
          ['RUN', 'WORK ORDER', 'AGE (H)', 'REVIEW'],
          ...r.owed.map((x) => [
            x.run_id,
            x.work_order_id,
            String(x.age_hours),
            review.has(x.run_id) ? 'yes' : '',
          ]),
        ]),
      );
    }
    return EXIT.OK;
  },
};

const result: Command = {
  path: ['relay', 'result'],
  usage: 'fw relay result <run> --file <path>',
  summary: "Store an agent's pasted result after checking it against the run-result schema",
  args: ['run'],
  options: ['file'],
  required: ['file'],
  async run(ctx) {
    const file = ctx.opts.file!;
    const text = readFileSync(resolve(ctx.io.cwd, file), 'utf8');
    const r = await need(ctx, 'relayResult')(ctx.args[0]!, text);
    ctx.io.out(
      ctx.json
        ? JSON.stringify(r, null, 2)
        : `stored the result for ${r.run_id}: ${r.status}, exit ${r.exit_code}`,
    );
    return EXIT.OK;
  },
};

export const relayCommands: Command[] = [prompt, owed, result];
