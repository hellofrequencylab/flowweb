// fw supervisor status: every flow fwd knows, and the one gate holding each (FW-C-033). Asks fwd;
// when fwd is down, the core client reads the database read-only and says so.
// fw supervisor pause|resume, fw supervisor enable|disable <flow>: the Owner's controls. They go
// through fwd with the CLI token, and each change writes a system.config_changed event.
// fw supervisor dial <flow> <draft|copilot|autopilot> [--confirm <hash>]: the Owner's dial (FW-C-035).
// Autopilot first answers with the hash of the flow's channels and caps; run it again with --confirm.
import type { SupervisorAction, SupervisorReport } from '../client.ts';
import { EXIT, table } from '../output.ts';
import type { Command, CommandContext } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

function print(ctx: CommandContext, r: SupervisorReport): number {
  if (ctx.json) {
    ctx.io.out(JSON.stringify(r, null, 2));
    return EXIT.OK;
  }
  const head = [
    r.source === 'database' ? 'fwd is down; read from the database, read-only' : 'fwd is up',
    r.kill_switch ? 'KILL SWITCH ENGAGED' : null,
    r.paused ? 'Supervisor paused by the Owner' : null,
    `runs at once: ${r.max_concurrent}`,
  ].filter(Boolean);
  const rows = r.flows.map((f) => [
    f.key,
    f.enabled ? 'on' : 'off',
    f.dial ?? 'draft',
    f.state,
    f.gate ?? '-',
    f.reason,
  ]);
  ctx.io.out([head.join(' · '), table([['FLOW', 'ON', 'DIAL', 'STATE', 'GATE', 'WHY'], ...rows])].join('\n'));
  return EXIT.OK;
}

const status: Command = {
  path: ['supervisor', 'status'],
  usage: 'fw supervisor status',
  summary: 'Show every flow, whether it may run, and the gate holding it',
  args: [],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.supervisorStatus !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    return print(ctx, await ctx.client.supervisorStatus());
  },
};

function control(action: SupervisorAction, withFlow: boolean, summary: string): Command {
  return {
    path: ['supervisor', action],
    usage: `fw supervisor ${action}${withFlow ? ' <flow>' : ''}`,
    summary,
    args: withFlow ? ['flow'] : [],
    options: [],
    async run(ctx) {
      if (typeof ctx.client.supervisorControl !== 'function')
        throw new UnsupportedError(
          'the core client in use does not serve the Supervisor; the daemon package provides it',
        );
      return print(ctx, await ctx.client.supervisorControl(action, withFlow ? ctx.args[0] : undefined));
    },
  };
}

const dial: Command = {
  path: ['supervisor', 'dial'],
  usage: 'fw supervisor dial <flow> <draft|copilot|autopilot> [--confirm <hash>]',
  summary: "Set a flow's dial; autopilot asks you to confirm its channels and caps (Owner)",
  args: ['flow', 'stop'],
  options: ['confirm'],
  async run(ctx) {
    if (typeof ctx.client.supervisorDial !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    const [flow = '', stop = ''] = ctx.args;
    return print(ctx, await ctx.client.supervisorDial(flow, stop, ctx.opts.confirm || undefined));
  },
};

export const supervisorCommands: Command[] = [
  status,
  control('pause', false, 'Pause the Supervisor: hold every flow until resumed (Owner)'),
  control('resume', false, 'Resume the Supervisor (Owner)'),
  control('enable', true, 'Turn a flow on (Owner)'),
  control('disable', true, 'Turn a flow off (Owner)'),
  dial,
];
