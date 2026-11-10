// fw hunt: the Owner's saved lead hunts in the neighborhood activation flow (FW-C-048). Every command
// goes through fwd's hunt and do-not-contact routes with the CLI token, so fwd's checks are the only
// checks. add saves a hunt (--link and --area may repeat; links are pages searched first), list shows
// them, run asks for one in the next cycle and fires the flow by hand, remove deletes one, and block
// adds an address or an @domain to do-not-contact when an organizer replies "no".
import { EXIT, table } from '../output.ts';
import type { Command, CommandContext } from './types.ts';

const BASE = '/v1/flows/neighborhood-activation';

type Hunt = {
  id: string;
  name: string;
  region: string;
  areas: string[];
  links: string[];
  every_days: number;
  max_sends: number;
  build: boolean;
  enabled: boolean;
  last_run_at: string | null;
};

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

class UsageError extends Error {
  readonly code = 'USAGE';
}

function api(ctx: CommandContext, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  if (typeof ctx.client.flowApi !== 'function')
    throw new UnsupportedError('the core client in use does not reach fwd; the daemon package provides it');
  return ctx.client.flowApi(method, `${BASE}${path}`, body);
}

function done(ctx: CommandContext, data: unknown, text: string): number {
  ctx.io.out(ctx.json ? JSON.stringify(data, null, 2) : text);
  return EXIT.OK;
}

const list = (v: string | undefined) => (v ? v.split('\n').filter(Boolean) : []);

function whole(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
}

const add: Command = {
  path: ['hunt', 'add'],
  usage:
    'fw hunt add --name <text> --looking-for <text> --region <id> [--area <id>]... [--link <url>]... [--every <days>] [--max <n>] [--build]',
  summary: 'Save a lead hunt; each --link is a page searched first (Owner)',
  args: [],
  options: ['name', 'looking-for', 'region', 'area', 'link', 'every', 'max', 'build'],
  required: ['name', 'looking-for', 'region'],
  async run(ctx) {
    const o = ctx.opts;
    const every = whole(o.every, 'every');
    const max = whole(o.max, 'max');
    const body = {
      name: o.name,
      looking_for: o['looking-for'],
      region: o.region,
      areas: list(o.area),
      links: list(o.link),
      ...(every !== undefined ? { every_days: every } : {}),
      ...(max !== undefined ? { max_sends: max } : {}),
      build: o.build === 'true',
    };
    const h = (await api(ctx, 'POST', '/hunts', body)) as Hunt;
    return done(
      ctx,
      h,
      `${h.id}: saved "${h.name}" (${h.links.length} link(s), every ${h.every_days} day(s))`,
    );
  },
};

const show: Command = {
  path: ['hunt', 'list'],
  usage: 'fw hunt list',
  summary: 'Show the saved lead hunts',
  args: [],
  options: [],
  async run(ctx) {
    const hunts = ((await api(ctx, 'GET', '/hunts')) ?? []) as Hunt[];
    const rows = hunts.map((h) => [
      h.id,
      h.name,
      h.region + (h.areas.length ? ` (${h.areas.join(', ')})` : ''),
      `${h.every_days}d`,
      String(h.max_sends),
      h.build ? 'yes' : 'no',
      String(h.links.length),
      h.last_run_at ?? 'never',
    ]);
    const text = hunts.length
      ? table([['ID', 'NAME', 'WHERE', 'EVERY', 'MAX', 'BUILD', 'LINKS', 'LAST RUN'], ...rows])
      : 'no hunts saved (fw hunt add)';
    return done(ctx, hunts, text);
  },
};

const run: Command = {
  path: ['hunt', 'run'],
  usage: 'fw hunt run <id>',
  summary: 'Run one hunt now; the Supervisor still decides whether the flow may (Owner)',
  args: ['id'],
  options: [],
  async run(ctx) {
    const id = encodeURIComponent(ctx.args[0] ?? '');
    const r = (await api(ctx, 'POST', `/hunts/${id}/run`, {})) as {
      hunt_id: string;
      fire_id: string;
      outcome: string;
      reason?: string;
    };
    return done(ctx, r, `${r.fire_id}: ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
  },
};

const remove: Command = {
  path: ['hunt', 'remove'],
  usage: 'fw hunt remove <id>',
  summary: 'Delete a saved hunt (Owner)',
  args: ['id'],
  options: [],
  async run(ctx) {
    const r = (await api(ctx, 'DELETE', `/hunts/${encodeURIComponent(ctx.args[0] ?? '')}`)) as {
      deleted: string;
    };
    return done(ctx, r, `${r.deleted}: deleted`);
  },
};

const block: Command = {
  path: ['hunt', 'block'],
  usage: 'fw hunt block <address or @domain> --reason <text>',
  summary: 'Never write to this address or domain again, for example after a "no" (Owner)',
  args: ['address'],
  options: ['reason'],
  required: ['reason'],
  async run(ctx) {
    const r = (await api(ctx, 'POST', '/do-not-contact', {
      email: ctx.args[0],
      reason: ctx.opts.reason,
    })) as { blocked: string; already: boolean };
    return done(ctx, r, `${r.blocked}: ${r.already ? 'already on' : 'added to'} the do-not-contact list`);
  },
};

export const huntCommands: Command[] = [add, show, run, remove, block];
