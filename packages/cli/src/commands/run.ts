// fw run start | list | show
import type { CoreClient, RunStartOptions } from '../client.ts';
import { EXIT, short, table, usd } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

function need<K extends 'runStart' | 'runList' | 'runShow'>(
  client: CoreClient,
  m: K,
): NonNullable<CoreClient[K]> {
  const fn = client[m];
  if (typeof fn !== 'function')
    throw new UnsupportedError(
      `the core client in use does not serve run commands (${m}); the daemon package provides them`,
    );
  return fn.bind(client) as NonNullable<CoreClient[K]>;
}

function positiveInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw Object.assign(new Error(`--${name} must be a positive whole number`), { code: 'BAD_ARGUMENT' });
  return n;
}

const start: Command = {
  path: ['run', 'start'],
  usage:
    'fw run start <code> [--adapter fake|noop|claude] [--scenario <name>] [--base <branch>] [--host gh|local:<path>] [--max-wall-clock-s <n>]',
  summary: 'Run a ready row end to end: worktree, sandbox, adapter, policy, evidence, pull request',
  args: ['code'],
  options: ['adapter', 'scenario', 'base', 'host', 'max-wall-clock-s'],
  async run(ctx) {
    const o: RunStartOptions = { repoDir: ctx.repoDir };
    if (ctx.opts.adapter) o.adapter = ctx.opts.adapter;
    if (ctx.opts.scenario) o.scenario = ctx.opts.scenario;
    if (ctx.opts.base) o.base = ctx.opts.base;
    if (ctx.opts.host) o.host = ctx.opts.host;
    const wall = positiveInt(ctx.opts['max-wall-clock-s'], 'max-wall-clock-s');
    if (wall !== undefined) o.maxWallClockS = wall;
    const r = await need(ctx.client, 'runStart')(ctx.args[0]!, o);
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else if (r.ok) {
      ctx.io.out(
        [
          `run start ${r.code}: ${r.status} ${r.run_id}`,
          table([
            ['  pr', r.pr ? `#${r.pr.number} ${r.pr.url}` : '-'],
            ['  evidence', `${r.evidence_bundle_id} (hash ${short(r.bundle_hash, 16)})`],
            ['  branch', r.branch ?? '-'],
            ['  sandbox', r.sandbox_level ?? '-'],
            ['  cost', `${usd(r.cost_usd)}${r.cost_estimated ? ' (estimated)' : ''}`],
            ['  row', r.row_status],
          ]),
        ].join('\n'),
      );
    } else {
      const what = r.run_id ? `${r.status} (${r.failure_class ?? 'no class'}) ${r.run_id}` : 'refused';
      ctx.io.out(`run start ${r.code}: ${what}: ${r.reason ?? 'no reason recorded'}`);
      if (r.worktree && r.run_id) ctx.io.out(`  worktree kept: ${r.worktree}\n  row: ${r.row_status}`);
    }
    return r.ok ? EXIT.OK : EXIT.FAILED;
  },
};

const list: Command = {
  path: ['run', 'list'],
  usage: 'fw run list [--status <status>] [--limit <n>]',
  summary: 'List runs, newest first',
  args: [],
  options: ['status', 'limit'],
  async run(ctx) {
    const limit = positiveInt(ctx.opts.limit, 'limit');
    const runs = await need(
      ctx.client,
      'runList',
    )({
      ...(ctx.opts.status ? { status: ctx.opts.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (ctx.json) ctx.io.out(JSON.stringify(runs, null, 2));
    else if (!runs.length) ctx.io.out('no runs');
    else
      ctx.io.out(
        table([
          ['RUN', 'ROW', 'STATUS', 'CLASS', 'ADAPTER', 'COST', 'QUEUED'],
          ...runs.map((r) => [
            r.id,
            r.row,
            r.status,
            r.failure_class ?? '-',
            r.adapter,
            usd(r.cost_usd),
            r.queued_at,
          ]),
        ]),
      );
    return EXIT.OK;
  },
};

const show: Command = {
  path: ['run', 'show'],
  usage: 'fw run show <run_id>',
  summary: 'Show one run: status, cost, artifacts, evidence bundle hashes and events',
  args: ['run_id'],
  options: [],
  async run(ctx) {
    const r = await need(ctx.client, 'runShow')(ctx.args[0]!);
    if (ctx.json) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return EXIT.OK;
    }
    const lines = [
      `${r.id}  ${r.row}  ${r.status}${r.failure_class ? ` (${r.failure_class})` : ''}`,
      table([
        ['  adapter', `${r.adapter} attempt ${r.attempt}`],
        ['  work order', r.work_order_id],
        ['  branch', r.branch ?? '-'],
        ['  workspace', r.workspace_path ?? '-'],
        ['  queued', r.queued_at],
        ['  ended', r.ended_at ?? '-'],
        ['  turns', String(r.turns)],
        ['  tokens', `${r.tokens_in} in, ${r.tokens_out} out`],
        [
          '  cost',
          r.cost.known
            ? `${usd(r.cost.usd)} (${r.cost.entries} spend entries)`
            : 'unknown (no spend recorded)',
        ],
        ['  steps', String(r.steps)],
      ]),
      'artifacts:',
      ...(r.artifacts.length
        ? r.artifacts.map(
            (a) =>
              `  ${a.kind} ${a.ref}${a.sha ? ` @ ${short(a.sha)}` : ''}${a.verified_by_kernel ? ' (kernel-verified)' : ' (claimed)'}`,
          )
        : ['  none']),
      'evidence:',
      ...(r.evidence.length
        ? r.evidence.map((e) => `  ${e.id} hash ${e.bundle_hash}${e.scan_red ? ' RED' : ''}`)
        : ['  none']),
      'events:',
      ...r.events.map((e) => `  ${String(e.seq).padStart(5)} ${e.ts} ${e.type}`),
    ];
    ctx.io.out(lines.join('\n'));
    return EXIT.OK;
  },
};

export const runCommands: Command[] = [start, list, show];
