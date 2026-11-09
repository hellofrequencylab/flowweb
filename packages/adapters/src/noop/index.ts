// No-op reference adapter (WS-P0-026): the smallest thing that implements VendorAdapter. It spawns no
// process, calls no network, reads no credential and writes no file. It records the prompt it would
// have sent, reports a session, spends nothing and produces no artifact.
//
// run-result.json requires at least one artifact when status is `completed`, so a run that produced
// nothing cannot be reported as completed. The noop ends the way the SDK engine ends any vendor run
// that exits 0 without an artifact: status `failed`, exit code 0, failure class `no_artifact`. The
// kernel then fails the run with that class and returns the row to ready.
import { createHash } from 'node:crypto';
import { buildPrompt } from '../sdk/prompt.ts';
import { AsyncQueue } from '../sdk/queue.ts';
import { Redactor } from '../sdk/redact.ts';
import type {
  AdapterEvent,
  AdapterRun,
  Fingerprint,
  PreflightReport,
  RunMeta,
  RunResult,
  RunStep,
  StartOptions,
  VendorAdapter,
  VendorAdapterInput,
} from '../sdk/types.ts';

export const NOOP_VERSION = '1.0.0';
export const NOOP_MODEL = 'noop';

/** What the noop adapter is, in the words its fingerprint hashes. */
export const NOOP_DESCRIPTION =
  'noop adapter: the no-op reference adapter. It runs no vendor, spawns no process, changes no files, spends nothing and produces no artifact.';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const NOOP_FINGERPRINT: Fingerprint = {
  name: 'noop',
  version: NOOP_VERSION,
  help_sha256: sha256(NOOP_DESCRIPTION),
};

export function createNoopAdapter(): VendorAdapter {
  const preflight = async (): Promise<PreflightReport> => ({
    fingerprint: { ...NOOP_FINGERPRINT },
    verified_flags: [],
  });

  const start = (input: VendorAdapterInput, opts: StartOptions = {}): AdapterRun => {
    const now = opts.now ?? (() => new Date());
    const iso = () => now().toISOString();
    const redactor = new Redactor(Object.values(opts.credentialEnv ?? {}));
    const queue = new AsyncQueue<AdapterEvent>();
    const emit = (e: AdapterEvent) => queue.push(redactor.deep(e));
    const startedAt = iso();
    const sessionId = `noop_${input.run_id}`;
    let killedReason: string | null = null;

    let resolveResult!: (r: RunResult) => void;
    let resolveMeta!: (m: RunMeta) => void;
    const result = new Promise<RunResult>((r) => (resolveResult = r));
    const meta = new Promise<RunMeta>((r) => (resolveMeta = r));

    const finish = () => {
      const stopped = killedReason !== null;
      const summary = stopped
        ? `noop adapter: stopped before it finished (${killedReason})`
        : 'noop adapter: no vendor was run, no files were changed and no artifact was produced';
      const runResult: RunResult = {
        schema_version: '1',
        run_id: input.run_id,
        work_order_id: input.work_order.id,
        adapter: { vendor: 'local', name: 'noop', version: NOOP_VERSION, model: NOOP_MODEL },
        session_id: sessionId,
        status: stopped ? 'stopped' : 'failed',
        exit_code: 0,
        started_at: startedAt,
        ended_at: iso(),
        cost: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, usd: 0 },
        turns: 0,
        tool_call_count: 0,
        artifacts: [],
        claims: [],
        summary,
      };
      const runMeta: RunMeta = {
        fingerprint: { ...NOOP_FINGERPRINT },
        cost: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, usd: 0, estimated: false },
        failure_class: stopped ? 'killed' : 'no_artifact',
        cap_breach: null,
        killed_reason: killedReason,
        pgid: null,
        error_count: 0,
        artifact_sources: [],
        stderr_tail: [],
      };
      resolveResult(redactor.deep(runResult));
      resolveMeta(redactor.deep(runMeta));
      queue.close();
    };

    // The run ends on a later tick, so start() returns first and a caller can still kill it. The
    // prompt step is recorded even when the run was killed first: every run starts with its prompt.
    setImmediate(() => {
      const at = iso();
      let prompt: string;
      try {
        prompt = buildPrompt(input, []);
      } catch (e) {
        prompt = `(the work order could not be rendered: ${(e as Error).message})`;
      }
      const content = redactor.text(
        `${NOOP_DESCRIPTION}\nThe prompt below was recorded, not sent.\n\n${prompt}`,
      );
      const step: RunStep = {
        id: `stp_${input.run_id.slice(4)}_0000`,
        run_id: input.run_id,
        seq: 0,
        kind: 'prompt',
        content_ref: null,
        content_hash: sha256(content),
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        started_at: at,
        ended_at: at,
        content,
      };
      emit({ type: 'step', step });
      emit({ type: 'session', session_id: sessionId, model: NOOP_MODEL, at });
      finish();
    });

    return {
      run_id: input.run_id,
      events: queue,
      result,
      meta,
      pgid: () => null,
      kill: async (reason: string) => {
        if (killedReason === null) {
          killedReason = reason.length > 300 ? `${reason.slice(0, 297)}...` : reason;
          emit({ type: 'killed', reason: killedReason, at: iso() });
        }
        await result;
      },
    };
  };

  return {
    name: 'noop',
    vendor: 'local',
    // Nothing to resume and nothing to spend; the result it returns is schema-valid.
    capabilities: { supports_resume: false, supports_schema: true, supports_budget_cap: false },
    start,
    fingerprint: async () => ({ ...NOOP_FINGERPRINT }),
    preflight,
  };
}
