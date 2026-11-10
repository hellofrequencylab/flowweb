// Fake vendor adapter: drives src/fake/vendor.mjs as a real child process so every SDK guarantee
// (process group kill, scrubbed env, redaction, caps) is exercised without a network or keys.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pricing, TokenUsage } from '../sdk/cost.ts';
import { count } from '../sdk/cost.ts';
import { type Driver, type LineParser, startRun, type VendorItem } from '../sdk/engine.ts';
import { AdapterError } from '../sdk/errors.ts';
import { parseJsonObject } from '../sdk/lines.ts';
import { buildSandboxEnv, execCapture } from '../sdk/process.ts';
import { buildPrompt, readInstructionFiles } from '../sdk/prompt.ts';
import type {
  AdapterRun,
  Fingerprint,
  PreflightReport,
  RunStatus,
  StartOptions,
  VendorAdapter,
  VendorAdapterInput,
} from '../sdk/types.ts';

export const FAKE_SCENARIOS = [
  'success',
  'fail',
  'hang',
  'secret_leak',
  'prompt_injection',
  'over_budget',
  'forbidden_path',
  'malformed_output',
  'fabricated_claim',
  'flow_drafts',
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

/**
 * The normalized outcome each scenario must produce under default caps. `hang` and `over_budget`
 * end only because the SDK enforces a cap (wall clock and budget respectively) or a kill.
 */
export const FAKE_EXPECTED: Record<FakeScenario, { status: RunStatus; note: string }> = {
  success: { status: 'completed', note: 'real commit in the worktree; reported cost' },
  fail: { status: 'failed', note: 'nonzero exit, no result' },
  hang: { status: 'timeout', note: 'ignores SIGTERM, spawns a grandchild; group is SIGKILLed' },
  secret_leak: { status: 'completed', note: 'every secret-shaped string redacted' },
  prompt_injection: { status: 'completed', note: 'injection text kept as data and flagged' },
  over_budget: { status: 'budget_exceeded', note: 'token usage breaches the budget cap' },
  forbidden_path: { status: 'completed', note: 'files_changed (from git) lists CODEOWNERS and probes/' },
  malformed_output: { status: 'failed', note: 'typed error events, missing structured output' },
  fabricated_claim: {
    status: 'completed',
    note: 'claimed artifact only; the kernel artifact guard must refuse it',
  },
  flow_drafts: { status: 'completed', note: 'a flow cycle: drafts.json in the cycle folder, no commit' },
};

const VENDOR_SCRIPT = fileURLToPath(new URL('./vendor.mjs', import.meta.url));
const SCENARIO_TAG = /\[fake:([a-z_]+)\]/;

const FAKE_PRICING: Pricing = { input_per_mtok: 1, output_per_mtok: 5, cached_per_mtok: 0.1 };

/** Scenario from the options, else the `[fake:<name>]` tag in the work order title, else success. */
export function fakeScenarioOf(input: VendorAdapterInput, opts: StartOptions = {}): FakeScenario {
  const name = opts.scenario ?? input.work_order.title.match(SCENARIO_TAG)?.[1] ?? 'success';
  if (!(FAKE_SCENARIOS as readonly string[]).includes(name)) {
    throw new AdapterError('unknown_scenario', `unknown fake scenario: ${name}`);
  }
  return name as FakeScenario;
}

function usageOf(v: unknown): TokenUsage | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    input_tokens: count(o.input_tokens),
    output_tokens: count(o.output_tokens),
    cached_tokens: count(o.cached_tokens),
  };
}

/** Parser for the fwfake/1 line protocol. Unknown fields and event types are ignored. */
export function createFakeParser(): LineParser {
  return (line: string): VendorItem[] => {
    const o = parseJsonObject(line);
    if (!o)
      return [
        { kind: 'error', code: 'malformed_line', message: 'stdout line is not a JSON object', raw: line },
      ];
    const bad = (what: string): VendorItem[] => [
      { kind: 'error', code: 'unexpected_shape', message: `fake ${String(o.t)} event: ${what}`, raw: line },
    ];
    switch (o.t) {
      case 'session':
        if (typeof o.session_id !== 'string' || !o.session_id) return bad('session_id missing');
        return [
          {
            kind: 'session',
            session_id: o.session_id,
            ...(typeof o.model === 'string' ? { model: o.model } : {}),
          },
        ];
      case 'turn': {
        if (typeof o.text !== 'string') return bad('text is not a string');
        const u = usageOf(o.usage);
        return [
          {
            kind: 'turn',
            text: o.text,
            ...(typeof o.id === 'string' ? { message_id: o.id } : {}),
            ...(u ? { usage: u } : {}),
          },
        ];
      }
      case 'tool_call':
        if (typeof o.id !== 'string' || typeof o.name !== 'string') return bad('id or name missing');
        return [{ kind: 'tool_call', id: o.id, name: o.name, input: o.input ?? null }];
      case 'tool_result':
        if (typeof o.id !== 'string' || typeof o.text !== 'string') return bad('id or text missing');
        return [{ kind: 'tool_result', id: o.id, text: o.text, is_error: o.is_error === true }];
      case 'result': {
        const u = usageOf(o.usage);
        return [
          {
            kind: 'result',
            ok: o.ok === true,
            ...(typeof o.usd === 'number' ? { usd: o.usd } : {}),
            ...(u ? { usage: u } : {}),
            ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
            report: o.report,
            artifacts: o.artifacts,
          },
        ];
      }
      default:
        return [];
    }
  };
}

export interface FakeAdapterOptions {
  /** Node binary used to run the scripted vendor. Defaults to the current one. */
  nodePath?: string;
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): VendorAdapter {
  const node = options.nodePath ?? process.execPath;
  let preflightCache: Promise<PreflightReport> | null = null;

  const preflight = (): Promise<PreflightReport> => {
    preflightCache ??= (async () => {
      const env = buildSandboxEnv({ home: '/nonexistent' });
      const v = await execCapture(node, [VENDOR_SCRIPT, '--version'], { env });
      const h = await execCapture(node, [VENDOR_SCRIPT, '--help'], { env });
      const version = v.stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (v.code !== 0 || !version)
        throw new AdapterError('version_unreadable', 'fake vendor --version failed');
      if (h.code !== 0) throw new AdapterError('preflight_failed', 'fake vendor --help failed');
      const fingerprint: Fingerprint = {
        name: 'fake',
        version,
        help_sha256: createHash('sha256').update(h.stdout).digest('hex'),
      };
      return { fingerprint, verified_flags: ['--version', '--help'] };
    })();
    preflightCache.catch(() => {
      preflightCache = null;
    });
    return preflightCache;
  };

  const driver: Driver = {
    name: 'fake',
    vendor: 'local',
    pricing: FAKE_PRICING,
    async prepare(input, opts) {
      const scenario = fakeScenarioOf(input, opts);
      const report = await preflight();
      const prompt = buildPrompt(input, readInstructionFiles(input));
      return {
        command: node,
        args: [VENDOR_SCRIPT],
        stdin: JSON.stringify({ scenario, run_id: input.run_id }),
        credentialEnv: { ...(opts.credentialEnv ?? {}) },
        fingerprint: report.fingerprint,
        model: 'fake-scripted',
        prompt,
      };
    },
    createParser: createFakeParser,
  };

  return {
    name: 'fake',
    vendor: 'local',
    capabilities: { supports_resume: false, supports_schema: true, supports_budget_cap: true },
    start: (input: VendorAdapterInput, opts?: StartOptions): AdapterRun => startRun(driver, input, opts),
    fingerprint: async () => (await preflight()).fingerprint,
    preflight,
  };
}
