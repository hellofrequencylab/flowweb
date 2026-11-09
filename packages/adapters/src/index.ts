// @fw/adapters: the vendor adapter SDK, the scripted fake vendor and the Claude headless adapter.
// Vendor names may appear in this package and nowhere else in the kernel.
import { CLAUDE_API_KEY_ENV, type ClaudeAdapterOptions, createClaudeAdapter } from './claude/index.ts';
import { createCodexAdapter } from './codex/index.ts';
import { createFakeAdapter, type FakeAdapterOptions } from './fake/index.ts';
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
export { createCodexAdapter } from './codex/index.ts';
export type { FakeAdapterOptions, FakeScenario } from './fake/index.ts';
export {
  createFakeAdapter,
  createFakeParser,
  FAKE_EXPECTED,
  FAKE_SCENARIOS,
  fakeScenarioOf,
} from './fake/index.ts';
export type { Pricing, TokenUsage } from './sdk/cost.ts';
export { costRecord, estimateUsd } from './sdk/cost.ts';
export type { Driver, LineParser, PreparedRun, VendorItem } from './sdk/engine.ts';
export { startRun, toolCallId } from './sdk/engine.ts';
export { AdapterError, isAdapterError } from './sdk/errors.ts';
export { detectInjection } from './sdk/injection.ts';
export { buildSandboxEnv, DENY_ALL_PROXY, ENV_ALLOWLIST, groupAlive, killGroup } from './sdk/process.ts';
export { findSecrets, Redactor, SECRET_PATTERNS } from './sdk/redact.ts';
export type * from './sdk/types.ts';

export const ADAPTER_NAMES = ['fake', 'claude', 'codex'] as const;
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
  claude: [{ handle: 'crd_claude0001', env: CLAUDE_API_KEY_ENV, required: true, scopes: ['vendor.api'] }],
  codex: [],
};

/** The adapter `fw run start` uses when neither --adapter nor $FW_VENDOR names one. */
export const DEFAULT_ADAPTER: AdapterName = 'claude';

export function isAdapterName(name: string): name is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(name);
}

export interface CreateAdapterOptions {
  fake?: FakeAdapterOptions;
  claude?: ClaudeAdapterOptions;
}

/** Adapter registry. `codex` is registered but throws until milestone C1. */
export function createAdapter(name: AdapterName, options: CreateAdapterOptions = {}): VendorAdapter {
  switch (name) {
    case 'fake':
      return createFakeAdapter(options.fake);
    case 'claude':
      return createClaudeAdapter(options.claude);
    case 'codex':
      return createCodexAdapter();
    default:
      throw new Error(`unknown adapter: ${String(name)}`);
  }
}
