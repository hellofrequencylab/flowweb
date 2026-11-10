// fw supervisor status: every flow fwd knows, and the one gate holding each (FW-C-033). Asks fwd;
// when fwd is down, the core client reads the database read-only and says so.
// fw supervisor pause|resume, fw supervisor enable|disable <flow>: the Owner's controls. They go
// through fwd with the CLI token, and each change writes a system.config_changed event.
// fw supervisor dial <flow> <draft|copilot|autopilot> [--confirm <hash>]: the Owner's dial (FW-C-035).
// fw supervisor run <flow>: fire a flow by hand through the scheduler (FW-C-038).
// fw supervisor drafts <flow>, approve|reject <flow> <id>: Copilot, the Owner's call on each cycle draft (FW-C-046).
// Autopilot first answers with the hash of the flow's channels and caps; run it again with --confirm.
import { readFileSync } from 'node:fs';
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

const run: Command = {
  path: ['supervisor', 'run'],
  usage: 'fw supervisor run <flow>',
  summary: 'Run a flow now; the Supervisor still decides whether it may (Owner)',
  args: ['flow'],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.supervisorRun !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    const r = await ctx.client.supervisorRun(ctx.args[0] ?? '');
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else
      ctx.io.out(
        r.outcome === 'fired'
          ? `${r.fire_id}: fired; the cycle runs in fwd`
          : `${r.fire_id}: ${r.outcome}: ${r.reason ?? ''}`,
      );
    return EXIT.OK;
  },
};

const drafts: Command = {
  path: ['supervisor', 'drafts'],
  usage: 'fw supervisor drafts <flow>',
  summary: "List a flow's cycle drafts, newest first, and whether each waits for you (Owner)",
  args: ['flow'],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.supervisorDrafts !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    const list = await ctx.client.supervisorDrafts(ctx.args[0] ?? '');
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ data: list }, null, 2));
      return EXIT.OK;
    }
    if (list.length === 0) {
      ctx.io.out('no drafts yet');
      return EXIT.OK;
    }
    const rows = list.map((d) => [
      d.id,
      d.status,
      d.held ?? '-',
      d.channel ?? '-',
      d.lead_id ?? '-',
      (d.subject ?? d.body).replace(/\s+/g, ' ').slice(0, 60),
    ]);
    ctx.io.out(table([['ID', 'STATUS', 'HELD', 'CHANNEL', 'LEAD', 'SUBJECT OR BODY'], ...rows]));
    return EXIT.OK;
  },
};

function draftAction(action: 'approve' | 'reject', summary: string): Command {
  return {
    path: ['supervisor', action],
    usage: `fw supervisor ${action} <flow> <id>`,
    summary,
    args: ['flow', 'id'],
    options: [],
    async run(ctx) {
      if (typeof ctx.client.supervisorDraft !== 'function')
        throw new UnsupportedError(
          'the core client in use does not serve the Supervisor; the daemon package provides it',
        );
      const [flow = '', id = ''] = ctx.args;
      const d = await ctx.client.supervisorDraft(action, flow, id);
      if (ctx.json) ctx.io.out(JSON.stringify(d, null, 2));
      else ctx.io.out(`${d.id}: ${d.status}`);
      return EXIT.OK;
    },
  };
}

const edit: Command = {
  path: ['supervisor', 'edit'],
  usage: 'fw supervisor edit <flow> <id> [--subject <text>] [--body <text> | --body-file <path>]',
  summary: "Change a draft's subject or text before it goes out (Owner)",
  args: ['flow', 'id'],
  options: ['subject', 'body', 'body-file'],
  async run(ctx) {
    if (typeof ctx.client.supervisorEditDraft !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    const [flow = '', id = ''] = ctx.args;
    const file = ctx.opts['body-file'];
    const change: { subject?: string; body?: string } = {};
    if (ctx.opts.subject !== undefined && ctx.opts.subject !== '') change.subject = ctx.opts.subject;
    if (file) change.body = readFileSync(file, 'utf8');
    else if (ctx.opts.body !== undefined && ctx.opts.body !== '') change.body = ctx.opts.body;
    const d = await ctx.client.supervisorEditDraft(flow, id, change);
    if (ctx.json) ctx.io.out(JSON.stringify(d, null, 2));
    else ctx.io.out(`${d.id}: edited (${d.status})`);
    return EXIT.OK;
  },
};

const rewrite: Command = {
  path: ['supervisor', 'rewrite'],
  usage: 'fw supervisor rewrite <flow> <id> --how <text>',
  summary: "Ask the flow's engine to rewrite a draft; prints the proposal and saves nothing (Owner)",
  args: ['flow', 'id'],
  options: ['how'],
  async run(ctx) {
    if (typeof ctx.client.supervisorRewriteDraft !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    const [flow = '', id = ''] = ctx.args;
    const p = await ctx.client.supervisorRewriteDraft(flow, id, ctx.opts.how ?? '');
    if (ctx.json) ctx.io.out(JSON.stringify({ data: p }, null, 2));
    else
      ctx.io.out(
        `${p.subject ? `${p.subject}\n\n` : ''}${p.body}\n\nSave it with: fw supervisor edit ${flow} ${id} --body-file <file>`,
      );
    return EXIT.OK;
  },
};

const mark: Command = {
  path: ['supervisor', 'mark'],
  usage: 'fw supervisor mark <flow> <id> <sent|replied|declined>',
  summary: 'Say what happened to a draft you sent by hand; declined adds them to do-not-contact (Owner)',
  args: ['flow', 'id', 'outcome'],
  options: [],
  async run(ctx) {
    if (typeof ctx.client.supervisorMarkDraft !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve the Supervisor; the daemon package provides it',
      );
    const [flow = '', id = '', outcome = ''] = ctx.args;
    const d = await ctx.client.supervisorMarkDraft(flow, id, outcome);
    if (ctx.json) ctx.io.out(JSON.stringify(d, null, 2));
    else ctx.io.out(`${d.id}: ${outcome}`);
    return EXIT.OK;
  },
};

export const supervisorCommands: Command[] = [
  status,
  control('pause', false, 'Pause the Supervisor: hold every flow until resumed (Owner)'),
  control('resume', false, 'Resume the Supervisor (Owner)'),
  control('enable', true, 'Turn a flow on (Owner)'),
  control('disable', true, 'Turn a flow off (Owner)'),
  dial,
  run,
  drafts,
  draftAction('approve', 'Approve one draft: it goes to the outbox, as at Autopilot (Owner, Copilot)'),
  draftAction('reject', 'Reject one draft: it is never handed off (Owner)'),
  edit,
  rewrite,
  mark,
];
