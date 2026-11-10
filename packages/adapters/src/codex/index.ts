// Codex exec adapter: `codex exec --json`, prompt on stdin, report constrained by --output-schema,
// resume through `codex exec resume <thread id>`. Argv uses only flags the preflight found in
// `codex exec --help`. Two credential lanes, picked by `auth` or FW_CODEX_AUTH=signin:
//   api_key  CODEX_API_KEY through injected env only, never argv (the row's default).
//   signin   the Codex CLI's own login (`codex login`, for example a ChatGPT plan) under CODEX_HOME;
//            no key is passed, and `codex login status` must succeed before each run.
// CODEX_HOME defaults to $CODEX_HOME, else ~/.codex; it also holds the sessions resume reads.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_REPORT_SCHEMA } from '../claude/index.ts';
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
import { RESUME_COMMAND, verifyCodexFlags } from './flags.ts';
import { createCodexParser } from './parse.ts';

export { CODEX_REQUIRED_FLAGS, verifyCodexFlags } from './flags.ts';
export { codexUsage, createCodexParser } from './parse.ts';

/** The API key the api_key lane accepts (the variable `codex exec` reads). */
export const CODEX_API_KEY_ENV = 'CODEX_API_KEY';

export type CodexAuth = 'api_key' | 'signin';

/** Estimate-only pricing: Codex reports tokens, not dollars. Override from config. */
export const CODEX_DEFAULT_PRICING: Pricing = {
  input_per_mtok: 1.25,
  output_per_mtok: 10,
  cached_per_mtok: 0.125,
};

export type CodexExec = (args: string[], env?: Record<string, string>) => Promise<ExecResult>;

export interface CodexAdapterOptions {
  /** Executable to run. Default `codex`. */
  command?: string;
  /** Arguments placed before the adapter's own argv (used by tests to drive a replay script). */
  commandArgs?: string[];
  /** Runs `<command> <args>` for the preflight and the sign-in check. Tests inject output here. */
  exec?: CodexExec;
  /** Credential lane. Default: FW_CODEX_AUTH when it is `signin`, else `api_key`. */
  auth?: CodexAuth;
  /** CODEX_HOME for runs and the sign-in check. Default $CODEX_HOME, else ~/.codex. */
  codexHome?: string;
  model?: string;
  pricing?: Pricing;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** OpenAI strict structured output: every object closed and every property required. */
export function strictSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (s === null || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === 'maxLength' || k === 'pattern') continue;
    out[k] =
      k === 'properties'
        ? Object.fromEntries(Object.entries(v as object).map(([p, d]) => [p, strictSchema(d)]))
        : strictSchema(v);
  }
  if (out.type === 'object' && out.properties) {
    out.required = Object.keys(out.properties as object);
    out.additionalProperties = false;
  }
  return out;
}

function schemaFile(): string {
  const text = JSON.stringify(strictSchema(AGENT_REPORT_SCHEMA));
  const file = join(
    tmpdir(),
    `fw-codex-report-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`,
  );
  if (!existsSync(file)) writeFileSync(file, text, { mode: 0o644 });
  return file;
}

export interface CodexArgvContext {
  verified: ReadonlySet<string>;
  resumeSessionId: string | null;
  schemaPath: string;
  model?: string;
}

/** Build argv from verified flags only. Throws AdapterError('missing_flag') otherwise. */
export function buildCodexArgv(ctx: CodexArgvContext): string[] {
  const need = (flag: string) => {
    if (!ctx.verified.has(flag)) throw new AdapterError('missing_flag', `not verified by preflight: ${flag}`);
    return flag;
  };
  const argv = ['exec'];
  if (ctx.resumeSessionId) {
    if (!SAFE_ID.test(ctx.resumeSessionId))
      throw new AdapterError('internal', 'resume_session_id has unsafe characters');
    argv.push(
      need(RESUME_COMMAND),
      ctx.resumeSessionId,
      need('--json'),
      need('--config'),
      'sandbox_mode="workspace-write"',
    );
  } else {
    argv.push(need('--json'), need('--sandbox'), 'workspace-write');
  }
  if (ctx.verified.has('--ignore-user-config')) argv.push('--ignore-user-config');
  argv.push(need('--output-schema'), ctx.schemaPath);
  if (ctx.model) {
    if (!SAFE_ID.test(ctx.model.replace(/[.:]/g, '_')))
      throw new AdapterError('internal', 'model has unsafe characters');
    argv.push(need('--model'), ctx.model);
  }
  argv.push('-'); // the prompt is read from stdin
  return argv;
}

/** The api_key lane: CODEX_API_KEY must be injected, and nothing else is passed. */
export function codexCredentialEnv(
  credentialEnv: Record<string, string> | undefined,
): Record<string, string> {
  const key = credentialEnv?.[CODEX_API_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0)
    throw new AdapterError(
      'credential_missing',
      `${CODEX_API_KEY_ENV} was not injected (or use the sign-in lane)`,
    );
  return { [CODEX_API_KEY_ENV]: key };
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): VendorAdapter {
  const command = options.command ?? 'codex';
  const prefix = options.commandArgs ?? [];
  const auth: CodexAuth = options.auth ?? (process.env.FW_CODEX_AUTH === 'signin' ? 'signin' : 'api_key');
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const exec: CodexExec =
    options.exec ??
    (async (args, extra) => {
      const home = mkdtempSync(join(tmpdir(), 'fw-codex-preflight-'));
      try {
        return await execCapture(command, [...prefix, ...args], {
          env: buildSandboxEnv({ home, ...(extra ? { extra } : {}) }),
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
      const h = await exec(['exec', '--help']);
      if (h.code !== 0 || !h.stdout.trim())
        throw new AdapterError('preflight_failed', `${command} exec --help failed`);
      return {
        fingerprint: {
          name: 'codex',
          version,
          help_sha256: createHash('sha256').update(h.stdout).digest('hex'),
        },
        verified_flags: verifyCodexFlags(h.stdout),
      };
    })();
    cache.catch(() => {
      cache = null;
    });
    return cache;
  };

  const driver: Driver = {
    name: 'codex-exec',
    vendor: 'openai',
    pricing: options.pricing ?? CODEX_DEFAULT_PRICING,
    async prepare(input: VendorAdapterInput, opts: StartOptions) {
      let credentialEnv: Record<string, string> = {};
      if (auth === 'api_key') credentialEnv = codexCredentialEnv(opts.credentialEnv);
      const report = await preflight();
      if (auth === 'signin') {
        const s = await exec(['login', 'status'], { CODEX_HOME: codexHome });
        if (s.code !== 0)
          throw new AdapterError(
            'credential_missing',
            `codex is not signed in under CODEX_HOME; run \`codex login\``,
          );
      }
      const resume = input.resume_session_id ?? null;
      const args = buildCodexArgv({
        verified: new Set(report.verified_flags),
        resumeSessionId: resume,
        schemaPath: schemaFile(),
        ...(options.model ? { model: options.model } : {}),
      });
      const prompt = buildPrompt(input, readInstructionFiles(input));
      return {
        command,
        args: [...prefix, ...args],
        stdin: prompt,
        extraEnv: { NO_COLOR: '1', CODEX_HOME: codexHome },
        credentialEnv,
        fingerprint: report.fingerprint,
        model: options.model ?? 'default',
        ...(resume ? { session_id: resume } : {}),
        prompt,
      };
    },
    createParser: createCodexParser,
  };

  return {
    name: 'codex-exec',
    vendor: 'openai',
    capabilities: { supports_resume: true, supports_schema: true, supports_budget_cap: false },
    start: (input: VendorAdapterInput, opts?: StartOptions): AdapterRun => startRun(driver, input, opts),
    fingerprint: async () => (await preflight()).fingerprint,
    preflight,
  };
}
