// fw reconcile: one pass of the git host reconciler. Compares the host's pull requests with the
// ledger, records merges made outside the tool (the row's post-merge probe is then queued for
// fw ledger close) and opens an Owner-owned row for each open PR no row accounts for.
import { EXIT, table } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

const reconcile: Command = {
  path: ['reconcile'],
  usage: 'fw reconcile [--host gh|local|local:<path>]',
  summary: 'Compare pull requests on the git host with the ledger and repair drift',
  args: [],
  options: ['host'],
  async run(ctx) {
    if (typeof ctx.client.reconcile !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the reconciler; the daemon package provides it',
      );
    const r = await ctx.client.reconcile(ctx.opts.host !== undefined ? { host: ctx.opts.host } : {});
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else {
      ctx.io.out(`checked ${r.checked} pull request(s); ${r.changes} change(s)`);
      if (r.drift.length)
        ctx.io.out(
          table([
            ['DRIFT', 'PULL REQUEST', 'ROW'],
            ...r.drift.map((d) => [d.kind, d.external_ref, d.ledger_row_id ?? '-']),
          ]),
        );
    }
    return EXIT.OK;
  },
};

export const reconcileCommands: Command[] = [reconcile];
