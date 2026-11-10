// Claude Code headless adapter: `claude --print --output-format stream-json`.
// Argv is built only from flags the preflight verified in the installed CLI's --help text.
// Two credential lanes, picked by `auth` or FW_CLAUDE_AUTH=signin (Owner decision C0-16):
//   api_key  ANTHROPIC_API_KEY through injected env only, never argv; runs with --bare (the default).
//   signin   CLAUDE_CODE_OAUTH_TOKEN (the long-lived token `claude setup-token` prints for a Claude
//            Pro/Max plan) through injected env only, never argv; ANTHROPIC_API_KEY is not passed.
//            No --bare: per the 2.1.319 help, --bare reads only ANTHROPIC_API_KEY and never OAuth.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pricing } from '../sdk/cost.ts';
import { type Driver, startRun } from '../sdk/engine.ts';
import { AdapterError } from '../sdk/errors.ts';
import { buildSandboxEnv, type ExecResult, execCapture } from '../sdk/process.ts';
import { buildPrompt, readInstructionFiles } from '../sdk/prompt.ts';
import type {
  AdapterRun,
  PreflightReport,
  StartOptions,
  VendorAdapter,
  VendorAdapterInput,
} from '../sdk/types.ts';
import { type ClaudeAuth, verifyFlags } from './flags.ts';
import { createClaudeParser } from './parse.ts';

export { type ClaudeAuth, parseHelp, REQUIRED_FLAGS, verifyFlags } from './flags.ts';
export { createClaudeParser } from './parse.ts';

/** The credential the api_key lane accepts. */
export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';
/** The credential the signin lane accepts: a Claude Pro/Max token from `claude setup-token`. */
export const CLAUDE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
/** Credential kinds the api_key lane refuses (subscription or bearer logins). */
export const CLAUDE_REJECTED_CREDENTIAL_ENV = [CLAUDE_OAUTH_TOKEN_ENV, 'ANTHROPIC_AUTH_TOKEN'];

/** The lane FW_CLAUDE_AUTH selects: `signin` when it says so, else `api_key`. */
export function claudeAuthFromEnv(env: Record<string, string | undefined> = process.env): ClaudeAuth {
  return env.FW_CLAUDE_AUTH === 'signin' ? 'signin' : 'api_key';
}

/** Estimate-only pricing, used when the CLI reports no total cost. Override from config. */
export const CLAUDE_DEFAULT_PRICING: Pricing = {
  input_per_mtok: 3,
  output_per_mtok: 15,
  cached_per_mtok: 0.3,
};

/** Structured report the agent must end with (passed via --json-schema). */
export const AGENT_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: 2000 },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          acceptance_id: { type: 'string', pattern: '^AC[0-9]{1,3}$' },
          claim: { type: 'string' },
          evidence_ref: { type: 'string' },
        },
        required: ['acceptance_id', 'claim'],
      },
    },
    followups: { type: 'array', items: { type: 'string', maxLength: 300 } },
    stop_requests: {
      type: 'array',
      items: {
        type: 'object',
        properties: { condition: { type: 'string' }, detail: { type: 'string', maxLength: 500 } },
        required: ['condition'],
      },
    },
    tests_added: { type: 'array', items: { type: 'string' } },
    tests_modified: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'claims'],
} as const;

export type CliExec = (args: string[]) => Promise<ExecResult>;

export interface ClaudeAdapterOptions {
  /** Executable to run. Default `claude`. */
  command?: string;
  /** Arguments placed before the adapter's own argv (used by tests to drive a replay script). */
  commandArgs?: string[];
  /** Runs `<command> <args>` for the preflight. Tests inject help text through this. */
  exec?: CliExec;
  /** Credential lane. Default: FW_CLAUDE_AUTH when it is `signin`, else `api_key`. */
  auth?: ClaudeAuth;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  pricing?: Pricing;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ArgvContext {
  verified: ReadonlySet<string>;
  /** Default `api_key`. */
  auth?: ClaudeAuth;
  sessionId: string | null;
  resumeSessionId: string | null;
  maxBudgetUsd?: number;
  model?: string;
  permissionMode: string;
  allowedTools?: string[];
}

/** Build argv from verified flags only. Throws AdapterError('missing_flag') otherwise. */
export function buildClaudeArgv(ctx: ArgvContext): string[] {
  const need = (flag: string) => {
    if (!ctx.verified.has(flag))
      throw new AdapterError('missing_flag', `flag not verified by preflight: ${flag}`);
    return flag;
  };
  const argv = [need('--print'), need('--output-format'), 'stream-json', need('--verbose')];
  if ((ctx.auth ?? 'api_key') === 'api_key') {
    argv.push(need('--bare'));
  } else {
    // signin: --bare would ignore the OAuth token, so the run is locked down another way. The engine
    // gives every run a fresh temporary HOME, so no user hooks, settings, memory or keychain login
    // are loaded; these keep the worktree's own project settings, hooks and MCP servers out too.
    if (ctx.verified.has('--setting-sources')) argv.push('--setting-sources', 'user');
    if (ctx.verified.has('--strict-mcp-config')) argv.push('--strict-mcp-config');
  }
  argv.push(
    need('--permission-mode'),
    ctx.permissionMode,
    need('--json-schema'),
    JSON.stringify(AGENT_REPORT_SCHEMA),
  );
  if (ctx.resumeSessionId) {
    if (!SAFE_ID.test(ctx.resumeSessionId))
      throw new AdapterError('internal', 'resume_session_id has unsafe characters');
    argv.push(need('--resume'), ctx.resumeSessionId);
  } else if (ctx.sessionId) {
    argv.push(need('--session-id'), ctx.sessionId);
  }
  if (typeof ctx.maxBudgetUsd === 'number' && ctx.maxBudgetUsd > 0) {
    argv.push(need('--max-budget-usd'), String(ctx.maxBudgetUsd));
  }
  if (ctx.model) {
    if (!SAFE_ID.test(ctx.model.replace(/[.:[\]]/g, '_')))
      throw new AdapterError('internal', 'model has unsafe characters');
    argv.push(need('--model'), ctx.model);
  }
  if (ctx.verified.has('--permission-prompts')) argv.push('--permission-prompts', 'none');
  if (ctx.allowedTools?.length) argv.push(need('--allowed-tools'), ctx.allowedTools.join(','));
  return argv;
}

/** Validate and narrow injected credentials to the lane's one variable. */
export function claudeCredentialEnv(
  credentialEnv: Record<string, string> | undefined,
  auth: ClaudeAuth = 'api_key',
): Record<string, string> {
  const env = credentialEnv ?? {};
  if (auth === 'signin') {
    if ('ANTHROPIC_AUTH_TOKEN' in env)
      throw new AdapterError('credential_rejected', 'credential kind ANTHROPIC_AUTH_TOKEN is not allowed');
    const token = env[CLAUDE_OAUTH_TOKEN_ENV];
    if (typeof token !== 'string' || token.length === 0)
      throw new AdapterError(
        'credential_missing',
        `${CLAUDE_OAUTH_TOKEN_ENV} was not injected (run \`claude setup-token\` and store it)`,
      );
    return { [CLAUDE_OAUTH_TOKEN_ENV]: token }; // an API key, if injected, is dropped
  }
  for (const k of CLAUDE_REJECTED_CREDENTIAL_ENV) {
    if (k in env)
      throw new AdapterError('credential_rejected', `credential kind ${k} is not allowed; API key only`);
  }
  const key = env[CLAUDE_API_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new AdapterError('credential_missing', `${CLAUDE_API_KEY_ENV} was not injected`);
  }
  return { [CLAUDE_API_KEY_ENV]: key };
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): VendorAdapter {
  const command = options.command ?? 'claude';
  const prefix = options.commandArgs ?? [];
  const auth: ClaudeAuth = options.auth ?? claudeAuthFromEnv();
  const exec: CliExec =
    options.exec ??
    (async (args) => {
      const home = mkdtempSync(join(tmpdir(), 'fw-claude-preflight-'));
      try {
        return await execCapture(command, [...prefix, ...args], {
          env: buildSandboxEnv({ home }),
          timeoutMs: 20000,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

  let cache: Promise<PreflightReport> | null = null;
  const preflight = (): Promise<PreflightReport> => {
    cache ??= (async () => {
      const v = await exec(['--version']);
      if (v.error && /ENOENT/.test(v.error)) throw new AdapterError('cli_not_found', `${command} not found`);
      const version = v.code === 0 ? v.stdout.match(/\d+\.\d+\.\d+[0-9A-Za-z.+-]*/)?.[0] : undefined;
      if (!version) throw new AdapterError('version_unreadable', `${command} --version gave no version`);
      const h = await exec(['--help']);
      if (h.code !== 0 || !h.stdout.trim())
        throw new AdapterError('preflight_failed', `${command} --help failed`);
      const verified_flags = verifyFlags(h.stdout, auth);
      return {
        fingerprint: {
          name: 'claude',
          version,
          help_sha256: createHash('sha256').update(h.stdout).digest('hex'),
        },
        verified_flags,
      };
    })();
    cache.catch(() => {
      cache = null;
    });
    return cache;
  };

  const driver: Driver = {
    name: 'claude-headless',
    vendor: 'anthropic',
    pricing: options.pricing ?? CLAUDE_DEFAULT_PRICING,
    async prepare(input: VendorAdapterInput, opts: StartOptions) {
      const credentialEnv = claudeCredentialEnv(opts.credentialEnv, auth);
      const report = await preflight();
      const resume = input.resume_session_id ?? null;
      const sessionId = resume ? null : randomUUID();
      const args = buildClaudeArgv({
        verified: new Set(report.verified_flags),
        auth,
        sessionId,
        resumeSessionId: resume,
        ...(typeof input.budget.max_usd === 'number' ? { maxBudgetUsd: input.budget.max_usd } : {}),
        ...(options.model ? { model: options.model } : {}),
        permissionMode: options.permissionMode ?? 'acceptEdits',
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      });
      const prompt = buildPrompt(input, readInstructionFiles(input));
      return {
        command,
        args: [...prefix, ...args],
        stdin: prompt,
        extraEnv: { NO_COLOR: '1' },
        credentialEnv,
        fingerprint: report.fingerprint,
        model: options.model ?? 'default',
        ...(sessionId ? { session_id: sessionId } : resume ? { session_id: resume } : {}),
        prompt,
      };
    },
    createParser: createClaudeParser,
  };

  return {
    name: 'claude-headless',
    vendor: 'anthropic',
    capabilities: { supports_resume: true, supports_schema: true, supports_budget_cap: true },
    start: (input: VendorAdapterInput, opts?: StartOptions): AdapterRun => startRun(driver, input, opts),
    fingerprint: async () => (await preflight()).fingerprint,
    preflight,
  };
}
