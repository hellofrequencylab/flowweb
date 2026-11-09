// WS-P0-028: the supervisor around any adapter run. The adapter SDK already enforces its caps; the
// supervisor is the independent second layer in the daemon: its own wall-clock timer, its own count
// of turns and dollars from the step stream, and a kill that it confirms by checking that no member
// of the vendor's process group is left. Every breach is reported once as a cap_breach naming the cap.
import {
  type AdapterEvent,
  type AdapterRun,
  type CapName,
  groupAlive,
  killGroup,
  type RunMeta,
  type RunResult,
  type StartOptions,
  type VendorAdapter,
  type VendorAdapterInput,
} from '@fw/adapters';

/** Slack past the cap before the supervisor fires, so the adapter's own timer normally wins. */
export const SUPERVISOR_SLACK_MS = 500;
export const DEFAULT_KILL_GRACE_MS = 1000;

export interface Breach {
  cap: CapName;
  limit: number;
  observed: number;
  /** Who saw it first. */
  by: 'adapter' | 'supervisor';
}

export interface SuperviseOptions {
  /** Called synchronously for every adapter event, in order, plus the supervisor's own cap_breach. */
  onEvent?: (e: AdapterEvent) => void;
  startOptions?: StartOptions;
  killGraceMs?: number;
}

export interface SupervisedOutcome {
  result: RunResult;
  meta: RunMeta;
  breach: Breach | null;
  /** Set when stop() was called (for example the database budget backstop killed the run). */
  stopped: string | null;
  /** True when, after the run, no live member of the vendor process group remained. */
  group_gone: boolean;
  duration_ms: number;
}

export interface SupervisedRun {
  readonly adapterRun: AdapterRun;
  readonly done: Promise<SupervisedOutcome>;
  /** Kills the run (whole process group) for a reason outside the caps. */
  stop(reason: string): Promise<void>;
}

function wallClockMs(input: VendorAdapterInput): number {
  let ms = input.caps.max_wall_clock_s * 1000;
  const m = input.budget.max_minutes;
  if (typeof m === 'number' && m > 0) ms = Math.min(ms, m * 60_000);
  return ms;
}

function turnLimit(input: VendorAdapterInput): number {
  const t = input.budget.max_turns;
  return typeof t === 'number' ? Math.min(t, input.caps.max_turns) : input.caps.max_turns;
}

export function startSupervised(
  adapter: VendorAdapter,
  input: VendorAdapterInput,
  opts: SuperviseOptions = {},
): SupervisedRun {
  const started = Date.now();
  const graceMs = opts.killGraceMs ?? opts.startOptions?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const run = adapter.start(input, { killGraceMs: graceMs, ...opts.startOptions });
  let breach: Breach | null = null;
  let stopped: string | null = null;
  let turns = 0;
  let usd = 0;
  let pgid: number | null = null;
  const emit = (e: AdapterEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // A failing observer must never keep a runaway alive; the pipeline records its own errors.
    }
  };

  const supervisorBreach = (cap: CapName, limit: number, observed: number) => {
    if (breach || stopped) return;
    breach = { cap, limit, observed, by: 'supervisor' };
    emit({ type: 'cap_breach', cap, limit, observed, at: new Date().toISOString() });
    void run.kill(`supervisor: ${cap} cap ${limit} exceeded (${observed})`);
  };

  const limitMs = wallClockMs(input);
  const timer = setTimeout(
    () => supervisorBreach('wall_clock', limitMs / 1000, (Date.now() - started) / 1000),
    limitMs + SUPERVISOR_SLACK_MS,
  );
  const maxTurns = turnLimit(input);
  const maxUsd = input.budget.max_usd;

  const pump = (async () => {
    for await (const e of run.events) {
      if (e.type === 'process' && e.phase === 'spawned' && e.pgid !== undefined) pgid = e.pgid;
      if (e.type === 'cap_breach' && !breach)
        breach = { cap: e.cap, limit: e.limit, observed: e.observed, by: 'adapter' };
      emit(e);
      if (e.type === 'step' && e.step.kind === 'model_turn') {
        turns++;
        usd += e.step.cost_usd;
        if (turns > maxTurns) supervisorBreach('turns', maxTurns, turns);
        else if (typeof maxUsd === 'number' && usd > maxUsd) supervisorBreach('usd', maxUsd, usd);
      }
    }
  })();

  const done = (async (): Promise<SupervisedOutcome> => {
    const [result, meta] = await Promise.all([run.result, run.meta, pump]).then(([r, m]) => [r, m] as const);
    clearTimeout(timer);
    const group = meta.pgid ?? pgid;
    // The adapter waits for its group to die; confirm independently and finish the job if not.
    if (group !== null && groupAlive(group)) await killGroup(group, graceMs);
    const outcome: SupervisedOutcome = {
      result,
      meta,
      breach: breach ?? (meta.cap_breach ? { ...meta.cap_breach, by: 'adapter' } : null),
      stopped,
      group_gone: group === null || !groupAlive(group),
      duration_ms: Date.now() - started,
    };
    return outcome;
  })();

  return {
    adapterRun: run,
    done,
    async stop(reason: string) {
      if (!stopped && !breach) stopped = reason;
      await run.kill(reason);
    },
  };
}

/** One supervised run to completion; resolves to the (redacted) run result. */
export async function supervise(
  adapter: VendorAdapter,
  input: VendorAdapterInput,
  opts: SuperviseOptions = {},
): Promise<RunResult & { cap_breach: Breach | null }> {
  const out = await startSupervised(adapter, input, opts).done;
  return { ...out.result, cap_breach: out.breach };
}
