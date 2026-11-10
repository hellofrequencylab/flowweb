// fw backup | restore (FW-C-029): a whole-home copy in one tar file, and putting it back into a
// fresh home. Credentials are never in a backup.
import { resolve } from 'node:path';
import { EXIT } from '../output.ts';
import { need } from './system.ts';
import type { Command } from './types.ts';

const backup: Command = {
  path: ['backup'],
  usage: 'fw backup --out <file>',
  summary: 'Write the database, config, policy and flows to one tar file (never the credentials)',
  args: [],
  options: ['out'],
  required: ['out'],
  async run(ctx) {
    const r = await need(ctx.client, 'backup')(resolve(ctx.opts.out as string));
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else ctx.io.out(`backup: wrote ${r.path} (${r.bytes} bytes, database ${r.db_hash.slice(0, 16)})`);
    return EXIT.OK;
  },
};

const restore: Command = {
  path: ['restore'],
  usage: 'fw restore <file>',
  summary: 'Restore a backup into this home (only when it has no database yet), then verify the chain',
  args: ['file'],
  options: [],
  async run(ctx) {
    const r = await need(ctx.client, 'restore')(resolve(ctx.args[0] as string));
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else
      ctx.io.out(
        `restore: ${r.home} now holds ${r.events} verified events; add your keys again (fw accounts connect)`,
      );
    return EXIT.OK;
  },
};

export const backupCommands: Command[] = [backup, restore];
