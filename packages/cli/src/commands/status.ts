// fw status: asks fwd (GET /v1/status); when fwd is down, the core client reads the database
// read-only instead. Exit 0 either way: a stopped daemon is a state to report, not a failure.
import { EXIT, table } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

const status: Command = {
  path: ['status'],
  usage: 'fw status',
  summary: 'Show whether fwd is up and the status strip (read from the database when fwd is down)',
  args: [],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.status !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve status; the daemon package provides it',
      );
    const s = await ctx.client.status();
    if (ctx.json) {
      ctx.io.out(JSON.stringify(s, null, 2));
      return EXIT.OK;
    }
    const chain = s.chain;
    const lines = [
      s.daemon === 'up'
        ? `daemon: up since ${s.started_at} (version ${s.version ?? 'unknown'})`
        : `daemon: down (${s.daemon_detail ?? 'not reachable'}); figures read from the database, read-only`,
    ];
    if (!s.database) lines.push(`no database in ${s.home} yet (run fw ledger sync first)`);
    else
      lines.push(
        table([
          ['  home', s.home],
          [
            '  chain',
            chain
              ? `${chain.ok === null ? 'not verified' : chain.ok ? 'ok' : `BROKEN at seq ${chain.failed_seq}`}, head seq ${chain.head_seq}`
              : 'unknown',
          ],
          ['  running runs', String(s.running_runs ?? 'unknown')],
          ['  open cards', String(s.open_cards ?? 'unknown')],
          [
            '  kill switch',
            s.kill?.engaged === true
              ? `ENGAGED${s.kill.reason ? ` (${s.kill.reason})` : ''}`
              : s.kill?.engaged === false
                ? 'off'
                : 'unknown',
          ],
        ]),
      );
    ctx.io.out(lines.join('\n'));
    return EXIT.OK;
  },
};

export const statusCommands: Command[] = [status];
