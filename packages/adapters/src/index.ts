// @fw/adapters: the vendor adapter SDK, the scripted fake vendor, the no-op reference adapter, the
// Claude headless adapter and the Codex exec adapter.
// Vendor names may appear in this package and nowhere else in the kernel.
import { CLAUDE_API_KEY_ENV, type ClaudeAdapterOptions, createClaudeAdapter } from './claude/index.ts';
import { CODEX_API_KEY_ENV, type CodexAdapterOptions, createCodexAdapter } from './codex/index.ts';
import { createFakeAdapter, type FakeAdapterOptions } from './fake/index.ts';
import { createNoopAdapter } from './noop/index.ts';
import type { VendorAdapter } from './sdk/types.ts';

export const PACKAGE = '@fw/adapters';

export type {
  ArgvContext,
  ClaudeAdapterOptions,
  CliExec,
} from './claude/index.ts';
export {
  AGENT_REPORT_SCHEMA,
  buildClaudeArgv,
  CLAUDE_API_KEY_ENV,
  createClaudeAdapter,
  createClaudeParser,
  parseHelp,
  REQUIRED_FLAGS,
  verifyFlags,
} from './claude/index.ts';
export type { CodexAdapterOptions, CodexArgvContext, CodexAuth, CodexExec } from './codex/index.ts';
export {
  buildCodexArgv,
  CODEX_API_KEY_ENV,
  CODEX_REQUIRED_FLAGS,
  codexUsage,
  createCodexAdapter,
  createCodexParser,
  strictSchema,
  verifyCodexFlags,
} from './codex/index.ts';
export type { FakeAdapterOptions, FakeScenario } from './fake/index.ts';
export {
  createFakeAdapter,
  createFakeParser,
  FAKE_EXPECTED,
  FAKE_SCENARIOS,
  fakeScenarioOf,
} from './fake/index.ts';
export { createNoopAdapter, NOOP_DESCRIPTION, NOOP_MODEL, NOOP_VERSION } from './noop/index.ts';
export type { Pricing, TokenUsage } from './sdk/cost.ts';
export { costRecord, estimateUsd } from './sdk/cost.ts';
export type { Driver, LineParser, PreparedRun, VendorItem } from './sdk/engine.ts';
export { startRun, toolCallId } from './sdk/engine.ts';
export { AdapterError, isAdapterError } from './sdk/errors.ts';
export { detectInjection } from './sdk/injection.ts';
export { buildSandboxEnv, DENY_ALL_PROXY, ENV_ALLOWLIST, groupAlive, killGroup } from './sdk/process.ts';
export { findSecrets, Redactor, SECRET_PATTERNS } from './sdk/redact.ts';
export type * from './sdk/types.ts';

export const ADAPTER_NAMES = ['fake', 'noop', 'claude', 'codex'] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

/**
 * Credentials an adapter may receive, by handle. The daemon resolves each handle (OS keychain or a
 * 0600 file under FW_HOME) and passes the value only in the vendor process environment, under `env`.
 * Kernel code reads this table instead of naming a vendor variable itself.
 */
export interface AdapterCredential {
  /** Credential handle id (vendor-adapter-input credentials_handle.handle_id). */
  handle: string;
  /** Environment variable of the vendor process that carries the secret. */
  env: string;
  /** A required credential that cannot be resolved fails the run before the vendor starts. */
  required: boolean;
  scopes: string[];
}

export const ADAPTER_CREDENTIALS: Readonly<Record<AdapterName, readonly AdapterCredential[]>> = {
  // The fake vendor needs no key; when the handle exists it is injected so leak tests have a value to hunt.
  fake: [{ handle: 'crd_fake0001', env: 'FAKE_VENDOR_API_KEY', required: false, scopes: ['vendor.api'] }],
  // The noop adapter runs nothing, so it is given nothing.
  noop: [],
  claude: [{ handle: 'crd_claude0001', env: CLAUDE_API_KEY_ENV, required: true, scopes: ['vendor.api'] }],
  // Not required: the sign-in lane (FW_CODEX_AUTH=signin) runs on the Codex CLI's own login instead.
  codex: [{ handle: 'crd_codex0001', env: CODEX_API_KEY_ENV, required: false, scopes: ['vendor.api'] }],
};

/** The adapter `fw run start` uses when neither --adapter nor $FW_VENDOR names one. */
export const DEFAULT_ADAPTER: AdapterName = 'claude';

export function isAdapterName(name: string): name is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(name);
}

export interface CreateAdapterOptions {
  fake?: FakeAdapterOptions;
  claude?: ClaudeAdapterOptions;
  codex?: CodexAdapterOptions;
}

/** Adapter registry. */
export function createAdapter(name: AdapterName, options: CreateAdapterOptions = {}): VendorAdapter {
  switch (name) {
    case 'fake':
      return createFakeAdapter(options.fake);
    case 'noop':
      return createNoopAdapter();
    case 'claude':
      return createClaudeAdapter(options.claude);
    case 'codex':
      return createCodexAdapter(options.codex);
    default:
      throw new Error(`unknown adapter: ${String(name)}`);
  }
}
