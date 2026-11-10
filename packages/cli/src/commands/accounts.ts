// fw accounts check: prove each Claude and ChatGPT (Codex) account fwd can run on with a tiny real
// test call, and say how to start fwd. The check
// writes $FW_HOME/accounts-check.json (yes/no and plain words only, never a secret) for the relay
// to show on Settings. Vendor steps live in ../accounts/; nothing here reaches the daemon.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AccountResult, type AccountsReport, checkAccounts, reportPassed } from '../accounts/checks.ts';
import { processSystem, type System } from '../accounts/system.ts';
import { EXIT } from '../output.ts';
import type { Command, CommandContext } from './types.ts';

export const REPORT_FILE = 'accounts-check.json';

type Only = 'claude' | 'codex' | undefined;

/** Tests replace the machine; everyone else gets the real one. */
let makeSystem = (home: string, env: NodeJS.ProcessEnv): System => processSystem(home, env);
export function setAccountsSystem(f: typeof makeSystem): void {
  makeSystem = f;
}

function fwHome(ctx: CommandContext): string {
  return ctx.home ?? ctx.io.env.FW_HOME ?? join(homedir(), '.flowweb');
}

function parseOnly(ctx: CommandContext): Only | Error {
  const v = ctx.opts.only;
  if (v === undefined || v === 'claude' || v === 'codex') return v;
  return new Error('--only takes claude or codex');
}

function mark(a: AccountResult): string {
  if (a.ok === true) return 'PASS';
  if (a.ok === false) return 'FAIL';
  return a.id.endsWith('_api_key') ? 'skip' : 'MISSING';
}

export function renderReport(r: AccountsReport, savedTo: string): string {
  const w = Math.max(...r.accounts.map((a) => a.label.length));
  const lines = ['Accounts (each one tested with a tiny real call):'];
  for (const a of r.accounts) {
    lines.push(`  ${mark(a).padEnd(7)} ${a.label.padEnd(w)}  ${a.handle ?? 'codex login'}  ${a.detail}`);
    if (a.ok !== true && a.fix) lines.push(`          fix: ${a.fix}`);
  }
  lines.push('');
  if (r.start_command) {
    lines.push('Start fwd with:', `  ${r.start_command}`);
    if (r.fwd_env.FW_CLAUDE_AUTH === null)
      lines.push('  (no Claude account works yet, so Claude runs will fail)');
    if (r.fwd_env.FW_CODEX_AUTH === null)
      lines.push('  (no ChatGPT/OpenAI account works yet, so Codex runs will fail)');
  } else {
    lines.push('No account works yet. Run: pnpm fw accounts connect');
  }
  lines.push('', `Saved the result (no secrets) to ${savedTo}. The relay shows it on Settings.`);
  return lines.join('\n');
}

async function runCheck(ctx: CommandContext, sys: System, only: Only): Promise<number> {
  const report = await checkAccounts(sys, only);
  const saved = sys.writeReport(REPORT_FILE, report);
  ctx.io.out(ctx.json ? JSON.stringify(report, null, 2) : renderReport(report, saved));
  return reportPassed(report) ? EXIT.OK : EXIT.FAILED;
}

const check: Command = {
  path: ['accounts', 'check'],
  usage: 'fw accounts check [--only claude|codex]',
  summary: 'Test each Claude and ChatGPT account with a tiny real call and say how to start fwd',
  args: [],
  options: ['only'],
  async run(ctx) {
    const only = parseOnly(ctx);
    if (only instanceof Error) throw Object.assign(only, { code: 'BAD_ARGUMENT' });
    return runCheck(ctx, makeSystem(fwHome(ctx), ctx.io.env), only);
  },
};

export const accountsCommands: Command[] = [check];
