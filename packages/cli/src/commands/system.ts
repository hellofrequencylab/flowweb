// fw doctor | gc: the sandbox self-test of this home, and removal of finished runs' directories.
import type { CoreClient } from '../client.ts';
import { EXIT, table } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

function need<K extends 'doctor' | 'gc'>(client: CoreClient, m: K): NonNullable<CoreClient[K]> {
  const fn = client[m];
  if (typeof fn !== 'function')
    throw new UnsupportedError(
      `the core client in use does not serve ${m}; the daemon package provides it (the sandbox lives there)`,
    );
  return fn.bind(client) as NonNullable<CoreClient[K]>;
}

const doctor: Command = {
  path: ['doctor'],
  usage: 'fw doctor',
  summary: 'Run the sandbox self-test and show each control as enforced, best_effort or absent',
  args: [],
  options: [],
  async run(ctx) {
    const r = await need(ctx.client, 'doctor')();
    if (ctx.json) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return EXIT.OK;
    }
    const s = r.sandbox;
    ctx.io.out(
      [
        `doctor: sandbox ${s.mode} on ${s.platform}, overall ${s.level} (home ${r.home})`,
        table(Object.entries(s.controls).map(([name, c]) => [`  ${name}`, c.level, c.detail])),
        ...s.notes.map((n) => `note: ${n}`),
      ].join('\n'),
    );
    return EXIT.OK;
  },
};

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

export const systemCommands: Command[] = [doctor, gc];
