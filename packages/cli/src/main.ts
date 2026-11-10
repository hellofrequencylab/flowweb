// fw command router. Global options: --json (one JSON document on stdout), --home <dir> (FW_HOME),
// --repo <dir> (the checkout to act on; default the current directory), --help.
// Exit codes: 0 ok, 1 failed or refused (not by policy), 2 usage, 3 refused by policy (error codes in
// POLICY_CODES, output.ts), 4 the database writer lock is held.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type CoreClient, type CoreClientFactory, loadCoreClientFactory } from './client.ts';
import { accountsCommands } from './commands/accounts.ts';
import { auditCommands } from './commands/audit.ts';
import { backupCommands } from './commands/backup.ts';
import { doctorCommands } from './commands/doctor.ts';
import { ledgerCommands } from './commands/ledger.ts';
import { policyCommands } from './commands/policy.ts';
import { projectCommands } from './commands/project.ts';
import { reconcileCommands } from './commands/reconcile.ts';
import { relayCommands } from './commands/relay.ts';
import { runCommands } from './commands/run.ts';
import { setupCommands } from './commands/setup.ts';
import { spendCommands } from './commands/spend.ts';
import { statusCommands } from './commands/status.ts';
import { streamCommands } from './commands/stream.ts';
import { supervisorCommands } from './commands/supervisor.ts';
import { systemCommands } from './commands/system.ts';
import type { Command } from './commands/types.ts';
import { woCommands } from './commands/wo.ts';
import { EXIT, exitCodeFor, type Io, processIo, toCliError } from './output.ts';

export const COMMANDS: Command[] = [
  ...setupCommands,
  ...ledgerCommands,
  ...woCommands,
  ...streamCommands,
  ...supervisorCommands,
  ...policyCommands,
  ...reconcileCommands,
  ...relayCommands,
  ...projectCommands,
  ...runCommands,
  ...spendCommands,
  ...auditCommands,
  ...backupCommands,
  ...doctorCommands,
  ...systemCommands,
  ...statusCommands,
  ...accountsCommands,
];

const GLOBAL = ['json', 'home', 'repo', 'help'];
const BOOLEAN = new Set(['json', 'help']);
const SHORT: Record<string, string> = { f: 'file' };

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  return [
    'usage: fw <command> [options]',
    '',
    'commands:',
    ...COMMANDS.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`),
    '',
    'global options:',
    '  --json          print one JSON document',
    '  --home <dir>    FlowWeb home (default $FW_HOME or ~/.flowweb)',
    '  --repo <dir>    repository checkout to act on (default: current directory)',
    '  --help, -h      this help',
    '',
    'exit codes: 0 ok, 1 failed or refused, 2 usage, 3 refused by policy (XL size, self-verification,',
    '            diff policy, stream tier without approval, kill switch engaged, budget exhausted),',
    '            4 database writer lock held',
  ].join('\n');
}

function optionSpec() {
  const names = new Set([...GLOBAL, ...COMMANDS.flatMap((c) => c.options)]);
  const spec: Record<string, { type: 'string' | 'boolean'; short?: string }> = {};
  for (const n of names) spec[n] = { type: BOOLEAN.has(n) ? 'boolean' : 'string' };
  spec.help = { type: 'boolean', short: 'h' };
  for (const [s, long] of Object.entries(SHORT)) if (spec[long]) spec[long].short = s;
  return spec;
}

function usageError(io: Io, json: boolean, message: string, usage?: string): number {
  if (json) io.out(JSON.stringify({ error: { code: 'USAGE', message } }));
  else io.err(`fw: ${message}${usage ? `\nusage: ${usage}` : '\n(run fw --help)'}`);
  return EXIT.USAGE;
}

export async function main(argv: string[], io: Io = processIo, factory?: CoreClientFactory): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options: optionSpec(), allowPositionals: true, strict: true });
  } catch (e) {
    return usageError(io, argv.includes('--json'), (e as Error).message);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const json = values.json === true;
  const pos = parsed.positionals;
  if (values.help || pos.length === 0) {
    if (json)
      io.out(JSON.stringify({ commands: COMMANDS.map((c) => ({ usage: c.usage, summary: c.summary })) }));
    else io.out(helpText());
    return pos.length === 0 && !values.help ? EXIT.USAGE : EXIT.OK;
  }
  const cmd = COMMANDS.find((c) => c.path.every((p, i) => pos[i] === p));
  if (!cmd) return usageError(io, json, `unknown command: ${pos.join(' ')}`);
  const args = pos.slice(cmd.path.length);
  if (args.length !== cmd.args.length)
    return usageError(
      io,
      json,
      `expected ${cmd.args.length ? cmd.args.map((a) => `<${a}>`).join(' ') : 'no arguments'}`,
      cmd.usage,
    );
  const allowed = new Set([...GLOBAL, ...cmd.options]);
  for (const [k, v] of Object.entries(values))
    if (v !== undefined && !allowed.has(k))
      return usageError(io, json, `option --${k} does not apply here`, cmd.usage);
  for (const r of cmd.required ?? [])
    if (typeof values[r] !== 'string') return usageError(io, json, `--${r} is required`, cmd.usage);

  // Relative paths are relative to where the command was typed.
  const repoDir = resolve(io.cwd, typeof values.repo === 'string' ? values.repo : '.');
  if (typeof values.rows === 'string') values.rows = resolve(io.cwd, values.rows);
  if (typeof values.home === 'string') values.home = resolve(io.cwd, values.home);
  if (typeof values.file === 'string') values.file = resolve(io.cwd, values.file);
  let client: CoreClient | undefined;
  try {
    const make = factory ?? (await loadCoreClientFactory(io.env));
    const project = {
      ...(typeof values.project === 'string' ? { slug: values.project } : {}),
      ...(typeof values['project-name'] === 'string' ? { name: values['project-name'] } : {}),
    };
    client = make({
      repoDir,
      ...(typeof values.home === 'string' ? { home: values.home } : {}),
      ...(Object.keys(project).length ? { project } : {}),
    });
    const opts: Record<string, string | undefined> = {};
    for (const o of cmd.options) if (typeof values[o] === 'string') opts[o] = values[o] as string;
    return await cmd.run({
      client,
      io,
      json,
      args,
      opts,
      repoDir,
      ...(typeof values.home === 'string' ? { home: values.home } : {}),
    });
  } catch (e) {
    const err = toCliError(e);
    if (json) io.out(JSON.stringify({ error: err }));
    else io.err(`fw ${cmd.path.join(' ')}: ${err.message}`);
    return exitCodeFor(err);
  } finally {
    client?.close();
  }
}
