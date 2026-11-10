// The four ways FlowWeb can reach a model, and a tiny real test of each. A check never prints,
// stores or reports a secret: details are our own words plus redacted vendor error text.
//   claude_signin   Claude Pro/Max token from `claude setup-token`, handle crd_claude0002
//   claude_api_key  Anthropic API key, handle crd_claude0001
//   codex_signin    the Codex CLI's own login (`codex login`, a ChatGPT plan), no handle
//   codex_api_key   OpenAI API key, handle crd_codex0001
import type { System } from './system.ts';

export type AccountId = 'claude_signin' | 'claude_api_key' | 'codex_signin' | 'codex_api_key';

export interface AccountResult {
  id: AccountId;
  label: string;
  /** The credential handle fwd reads, or null for the Codex login (it lives under CODEX_HOME). */
  handle: string | null;
  /** false: nothing stored or signed in. null: cannot tell (the CLI is missing). */
  set_up: boolean | null;
  /** The test call: true passed, false failed, null not attempted (not set up). */
  ok: boolean | null;
  detail: string;
  fix?: string;
}

export interface AccountsReport {
  checked_at: string;
  accounts: AccountResult[];
  /** The environment to start fwd with, from what passed. */
  fwd_env: { FW_CLAUDE_AUTH: 'signin' | 'api_key' | null; FW_CODEX_AUTH: 'signin' | 'api_key' | null };
  start_command: string | null;
}

export const HANDLES = {
  claude_signin: 'crd_claude0002',
  claude_api_key: 'crd_claude0001',
  codex_api_key: 'crd_codex0001',
} as const;

export const TEST_PROMPT = 'Reply with the single word OK.';
const CONNECT = 'pnpm fw accounts connect';

/** Removes anything shaped like a vendor secret, plus the literals given, and keeps it short. */
export function redact(text: string, literals: string[] = []): string {
  let out = text;
  for (const l of literals) if (l.length >= 8) out = out.split(l).join('[redacted]');
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}[A-Za-z0-9._-]*)/g, '[redacted]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 240 ? `${out.slice(0, 237)}...` : out;
}

function parseLast(text: string): { is_error?: boolean; result?: string } {
  try {
    return JSON.parse(text.trim().split('\n').pop() || '{}');
  } catch {
    return {}; // not JSON: judged by the exit code and stderr
  }
}

/** A small environment for a test call: no vendor keys from the shell leak in. */
function cleanEnv(sys: System, extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (sys.env[k] !== undefined) env[k] = sys.env[k];
  return { ...env, ...extra };
}

function installed(sys: System, cli: string): boolean {
  const r = sys.run(cli, ['--version']);
  return !r.error && r.code === 0;
}

function refusedFix(text: string, again: string): string {
  if (/usage limit|rate limit|quota|429/i.test(text))
    return 'the account is signed in but over its usage limit; try again later';
  if (/401|403|unauthori[sz]ed|invalid|expired|revoked|authenticat|log ?in/i.test(text))
    return `the account refused the credential; ${again}`;
  return `the test call failed; check your network, then ${again}`;
}

export async function checkClaudeSignin(sys: System): Promise<AccountResult> {
  const base = { id: 'claude_signin', label: 'Claude Max sign-in', handle: HANDLES.claude_signin } as const;
  const again = `run \`claude setup-token\` again and store the new token with \`${CONNECT} --only claude\``;
  const s = sys.getSecret(HANDLES.claude_signin);
  if (!s)
    return { ...base, set_up: false, ok: null, detail: 'no sign-in token stored', fix: `run \`${CONNECT}\`` };
  if (!installed(sys, 'claude'))
    return {
      ...base,
      set_up: true,
      ok: false,
      detail: 'the claude CLI is not installed, so fwd cannot use the token',
      fix: 'install Claude Code (npm install -g @anthropic-ai/claude-code), then check again',
    };
  // A fresh HOME, so the call proves the stored token works and not the CLI's own keychain login.
  const home = sys.tempDir();
  const r = sys.run('claude', ['-p', '--output-format', 'json', '--max-turns', '1', TEST_PROMPT], {
    env: cleanEnv(sys, { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: s.value }),
    cwd: home,
    timeoutMs: 120_000,
  });
  const parsed = parseLast(r.stdout);
  if (r.code === 0 && parsed.is_error !== true)
    return { ...base, set_up: true, ok: true, detail: `answered a test call (token in ${s.where})` };
  const why = redact(`${parsed.result ?? ''} ${r.stderr} ${r.error ?? ''}`, [s.value]) || `exit ${r.code}`;
  return { ...base, set_up: true, ok: false, detail: why, fix: refusedFix(why, again) };
}

async function checkKey(
  sys: System,
  base: Pick<AccountResult, 'id' | 'label' | 'handle'>,
  url: string,
  headers: (key: string) => Record<string, string>,
): Promise<AccountResult> {
  const handle = base.handle as string;
  const s = sys.getSecret(handle);
  if (!s)
    return { ...base, set_up: false, ok: null, detail: 'not stored (optional)', fix: `run \`${CONNECT}\`` };
  const r = await sys.get(url, headers(s.value));
  if (r.status === 200)
    return { ...base, set_up: true, ok: true, detail: `the API accepted the key (key in ${s.where})` };
  const again = `store a new key with \`${CONNECT}\``;
  if (r.status === null)
    return {
      ...base,
      set_up: true,
      ok: false,
      detail: `could not reach the API: ${redact(r.error ?? 'no response', [s.value])}`,
      fix: 'check your network, then run the check again',
    };
  const why = `the API answered HTTP ${r.status}`;
  return { ...base, set_up: true, ok: false, detail: why, fix: refusedFix(why, again) };
}

export function checkClaudeApiKey(sys: System): Promise<AccountResult> {
  return checkKey(
    sys,
    { id: 'claude_api_key', label: 'Anthropic API key', handle: HANDLES.claude_api_key },
    'https://api.anthropic.com/v1/models?limit=1',
    (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  );
}

export function checkCodexApiKey(sys: System): Promise<AccountResult> {
  return checkKey(
    sys,
    { id: 'codex_api_key', label: 'OpenAI API key', handle: HANDLES.codex_api_key },
    'https://api.openai.com/v1/models',
    (k) => ({ authorization: `Bearer ${k}` }),
  );
}

export async function checkCodexSignin(sys: System): Promise<AccountResult> {
  const base = { id: 'codex_signin', label: 'ChatGPT sign-in (Codex)', handle: null } as const;
  if (!installed(sys, 'codex'))
    return {
      ...base,
      set_up: false,
      ok: null,
      detail: 'the codex CLI is not installed',
      fix: `install it (npm install -g @openai/codex), then run \`${CONNECT} --only codex\``,
    };
  // Without the API key variables, so the check proves the login and not a key from the shell.
  const env = cleanEnv(sys, {
    HOME: sys.env.HOME ?? '',
    ...(sys.env.CODEX_HOME ? { CODEX_HOME: sys.env.CODEX_HOME } : {}),
  });
  const st = sys.run('codex', ['login', 'status'], { env });
  const said = redact(`${st.stdout} ${st.stderr}`);
  if (st.code !== 0)
    return {
      ...base,
      set_up: false,
      ok: null,
      detail: 'not signed in',
      fix: `run \`${CONNECT} --only codex\``,
    };
  const note = /api key/i.test(said) ? ' (this login uses an API key, not a ChatGPT plan)' : '';
  const help = sys.run('codex', ['exec', '--help'], { env }).stdout;
  const args = ['exec'];
  if (help.includes('--skip-git-repo-check')) args.push('--skip-git-repo-check');
  if (help.includes('--sandbox')) args.push('--sandbox', 'read-only');
  args.push(TEST_PROMPT);
  const r = sys.run('codex', args, { env, cwd: sys.tempDir(), timeoutMs: 180_000 });
  if (r.code === 0) return { ...base, set_up: true, ok: true, detail: `answered a test call${note}` };
  const why = redact(`${r.stderr} ${r.error ?? ''}`) || `exit ${r.code}`;
  return {
    ...base,
    set_up: true,
    ok: false,
    detail: why,
    fix: refusedFix(why, `run \`codex login\` again, then \`pnpm fw accounts check\``),
  };
}

export const CHECKS: Record<AccountId, (sys: System) => Promise<AccountResult>> = {
  claude_signin: checkClaudeSignin,
  claude_api_key: checkClaudeApiKey,
  codex_signin: checkCodexSignin,
  codex_api_key: checkCodexApiKey,
};

export async function checkAccounts(
  sys: System,
  only?: 'claude' | 'codex',
  now: () => Date = () => new Date(),
): Promise<AccountsReport> {
  const ids = (Object.keys(CHECKS) as AccountId[]).filter((id) => !only || id.startsWith(only));
  const accounts: AccountResult[] = [];
  for (const id of ids) accounts.push(await CHECKS[id](sys));
  const passed = (id: AccountId) => accounts.find((a) => a.id === id)?.ok === true;
  const lane = (v: 'claude' | 'codex'): 'signin' | 'api_key' | null =>
    passed(`${v}_signin`) ? 'signin' : passed(`${v}_api_key`) ? 'api_key' : null;
  const fwd_env = { FW_CLAUDE_AUTH: lane('claude'), FW_CODEX_AUTH: lane('codex') };
  const parts = [
    ...(fwd_env.FW_CLAUDE_AUTH === 'signin' ? ['FW_CLAUDE_AUTH=signin'] : []),
    ...(fwd_env.FW_CODEX_AUTH === 'signin' ? ['FW_CODEX_AUTH=signin'] : []),
  ];
  const any = fwd_env.FW_CLAUDE_AUTH !== null || fwd_env.FW_CODEX_AUTH !== null;
  return {
    checked_at: now().toISOString(),
    accounts,
    fwd_env,
    start_command: any ? [...parts, 'pnpm fwd'].join(' ') : null,
  };
}

/** Passed: nothing that is set up failed, and at least one account works. */
export function reportPassed(r: AccountsReport): boolean {
  return r.start_command !== null && !r.accounts.some((a) => a.set_up === true && a.ok === false);
}
