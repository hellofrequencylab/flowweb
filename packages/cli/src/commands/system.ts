// fw gc: removal of finished runs' directories. (fw doctor lives in doctor.ts.)
import type { CoreClient } from '../client.ts';
import { EXIT } from '../output.ts';
import type { Command } from './types.ts';

export class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

export function need<K extends 'doctor' | 'gc'>(client: CoreClient, m: K): NonNullable<CoreClient[K]> {
  const fn = client[m];
  if (typeof fn !== 'function')
    throw new UnsupportedError(
      `the core client in use does not serve ${m}; the daemon package provides it (the sandbox lives there)`,
    );
  return fn.bind(client) as NonNullable<CoreClient[K]>;
}

const gc: Command = {
  path: ['gc'],
  usage: 'fw gc',
  summary: 'Remove run directories of finished runs (never a running run, a worktree or a branch)',
  args: [],
  options: [],
  async run(ctx) {
    const r = await need(ctx.client, 'gc')();
    if (ctx.json) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return EXIT.OK;
    }
    const lines = [
      `gc: removed ${r.removed.length} run director${r.removed.length === 1 ? 'y' : 'ies'}, kept ${r.kept.length} of active runs`,
      ...r.removed.map((e) => `  removed ${e.run_id} (${e.status ?? 'no run in the database'})`),
      ...r.kept.map((e) => `  kept    ${e.run_id} (${e.status})`),
      ...r.skipped.map((e) => `  skipped ${e.name} (${e.reason})`),
    ];
    ctx.io.out(lines.join('\n'));
    return EXIT.OK;
  },
};

export const systemCommands: Command[] = [gc];
