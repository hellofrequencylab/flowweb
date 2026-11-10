// fw accounts connect | check: sign in the Claude and ChatGPT (Codex) accounts fwd runs on, store
// the tokens under the handles fwd reads, and prove each one with a tiny real test call. The check
// writes $FW_HOME/accounts-check.json (yes/no and plain words only, never a secret) for the relay
// to show on Settings. Vendor steps live in ../accounts/; nothing here reaches the daemon.
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AccountResult,
  type AccountsReport,
  checkAccounts,
  HANDLES,
  reportPassed,
} from '../accounts/checks.ts';
import { processSystem, type System } from '../accounts/system.ts';
import { EXIT, type Io } from '../output.ts';
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

/** The steps `connect` walks through, for --json and for anyone reading the code. */
export const CONNECT_STEPS = [
  { vendor: 'claude', account: 'claude_signin', run: 'claude setup-token', store_as: HANDLES.claude_signin },
  { vendor: 'claude', account: 'claude_api_key', optional: true, store_as: HANDLES.claude_api_key },
  { vendor: 'codex', account: 'codex_signin', run: 'codex login', check: 'codex login status' },
  { vendor: 'codex', account: 'codex_api_key', optional: true, store_as: HANDLES.codex_api_key },
] as const;

const yes = (a: string) => /^y(es)?$/i.test(a);

async function storeSecret(io: Io, sys: System, handle: string, prompt: string): Promise<boolean> {
  for (let tries = 0; tries < 2; tries++) {
    const v = await sys.ask(prompt, { hidden: true });
    if (!v) return false;
    try {
      const where = sys.setSecret(handle, v);
      io.out(`  Stored as ${handle} in ${where === 'keychain' ? 'your keychain' : `${sys.home}/creds`}.`);
      return true;
    } catch (e) {
      io.out(`  ${(e as Error).message}. Paste the whole value, or press Enter to skip.`);
    }
  }
  return false;
}

async function connectClaude(io: Io, sys: System): Promise<void> {
  io.out('\n== Claude (your Max plan) ==');
  if (sys.run('claude', ['--version']).error) {
    io.out('  The claude CLI is not installed. Install it with: npm install -g @anthropic-ai/claude-code');
    return;
  }
  const have = sys.getSecret(HANDLES.claude_signin) !== null;
  if (!have || yes(await sys.ask('  A Claude sign-in token is already stored. Replace it? [y/N] '))) {
    io.out(
      '  Running `claude setup-token`. It opens your browser: sign in with your Max account.\n' +
        '  At the end it prints a long token starting with sk-ant-oat. Copy all of it.',
    );
    sys.run('claude', ['setup-token'], { interactive: true, timeoutMs: 600_000 });
    await storeSecret(
      io,
      sys,
      HANDLES.claude_signin,
      '  Paste the token (it stays hidden), or Enter to skip: ',
    );
  }
  await storeSecret(
    io,
    sys,
    HANDLES.claude_api_key,
    '  Optional: paste an Anthropic API key as a fallback (hidden), or Enter to skip: ',
  );
}

async function connectCodex(io: Io, sys: System): Promise<void> {
  io.out('\n== ChatGPT (Codex) ==');
  if (sys.run('codex', ['--version']).error) {
    io.out('  The codex CLI is not installed. Install it with: npm install -g @openai/codex');
    return;
  }
  const status = sys.run('codex', ['login', 'status']);
  const signedIn = status.code === 0;
  if (!signedIn || yes(await sys.ask('  Codex is already signed in. Sign in again? [y/N] '))) {
    io.out('  Running `codex login`. It opens your browser: choose "Sign in with ChatGPT".');
    sys.run('codex', ['login'], { interactive: true, timeoutMs: 600_000 });
  }
  await storeSecret(
    io,
    sys,
    HANDLES.codex_api_key,
    '  Optional: paste an OpenAI API key as a fallback (hidden), or Enter to skip: ',
  );
}

const connect: Command = {
  path: ['accounts', 'connect'],
  usage: 'fw accounts connect [--only claude|codex]',
  summary: 'Walk through signing in Claude and ChatGPT (Codex), store the tokens, then test them',
  args: [],
  options: ['only'],
  async run(ctx) {
    const only = parseOnly(ctx);
    if (only instanceof Error) throw Object.assign(only, { code: 'BAD_ARGUMENT' });
    if (ctx.json) {
      // connect asks questions, so --json prints the steps it would walk through instead.
      ctx.io.out(JSON.stringify({ steps: CONNECT_STEPS.filter((x) => !only || x.vendor === only) }, null, 2));
      return EXIT.OK;
    }
    const sys = makeSystem(fwHome(ctx), ctx.io.env);
    ctx.io.out('FlowWeb account setup. Tokens go to your keychain; nothing is printed or uploaded.');
    if (only !== 'codex') await connectClaude(ctx.io, sys);
    if (only !== 'claude') await connectCodex(ctx.io, sys);
    ctx.io.out('\n== Testing ==');
    return runCheck(ctx, sys, only);
  },
};

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

export const accountsCommands: Command[] = [connect, check];
