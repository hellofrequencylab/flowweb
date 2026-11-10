// FW-C-033: the Supervisor's gates, as pure code. Given what is true about one flow right now, say
// whether it may run, and if not, name the ONE gate holding it. The gates are checked in a fixed
// order, so the answer never depends on luck and the UI never has to guess why a flow is idle.
// No clock, no I/O: every fact is passed in. Design: https://claude.ai/artifact/SWupbhYmuvW36xGdfb5mYn
//
// "overseer" in code, "Supervisor" on screen: pipeline/supervisor.ts already names the per-run caps.

/** The closed list of gates, in the order they are checked. The first one that holds wins. */
export const GATES = [
  'kill_switch',
  'supervisor_paused',
  'dial_unapproved',
  'flow_disabled',
  'no_engine',
  'cap_required',
  'budget',
  'open_asks',
  'dormant',
  'stalled',
  'wip',
  'not_due',
  'machine_busy',
] as const;
export type Gate = (typeof GATES)[number];

/**
 * The Owner's dial for one flow (FW-C-035). Draft only drafts; Copilot acts after the Owner approves
 * each item; Autopilot runs on its own and hands finished items to a sender outside Core. Core never
 * sends at any stop.
 */
export const DIALS = ['draft', 'copilot', 'autopilot'] as const;
export type Dial = (typeof DIALS)[number];

/** Unanswered asks a flow may stack before it waits for the Owner. */
export const ASK_CAP = 3;
/** Passes in a row that found nothing to do before a flow goes dormant. */
export const DRY_STOP = 3;
/** Passes in a row that changed nothing before a flow pauses itself (the stall breaker). */
export const STALL_STOP = 3;

export interface Spend {
  usd: number;
  turns: number;
}

export interface Caps {
  /** Null: no dollar cap, so the budget gate never holds on dollars. */
  max_usd: number | null;
  max_turns: number | null;
  period: string;
}

/** Everything the gates need to know about one flow, at one moment. */
export interface FlowFacts {
  key: string;
  enabled: boolean;
  /** fwd has decision logic for this flow (a module under src/flows/). */
  has_engine: boolean;
  dial: Dial;
  /** At autopilot: the Owner confirmed the flow's current channels and caps (their hash still matches). */
  dial_confirmed: boolean;
  caps: Caps | null;
  spend: Spend | null;
  open_asks: number;
  dry_streak: number;
  stall_streak: number;
  running: number;
  wip_limit: number;
  /** A scheduled or manual fire is waiting. */
  due: boolean;
}

export interface SupervisorFacts {
  kill_switch: boolean;
  paused: boolean;
  /** Runs in flight across every flow, and how many the machine takes at once. */
  running_total: number;
  max_concurrent: number;
}

export type FlowState = 'ready' | 'held' | 'running';

export interface Verdict {
  state: FlowState;
  gate: Gate | null;
  reason: string;
}

/** True once a set cap is used up. A cap that is not set never runs out. */
export function capUsed(caps: Caps | null, spend: Spend | null): boolean {
  if (!caps || !spend) return false;
  if (caps.max_usd !== null && spend.usd >= caps.max_usd) return true;
  return caps.max_turns !== null && spend.turns >= caps.max_turns;
}

function held(gate: Gate, reason: string): Verdict {
  return { state: 'held', gate, reason };
}

/** The verdict for one flow. Order matters: the kill switch beats everything, then the Owner's pause. */
export function decide(f: FlowFacts, s: SupervisorFacts): Verdict {
  if (s.kill_switch)
    return held('kill_switch', 'The kill switch is engaged. Nothing runs until the Owner releases it.');
  if (s.paused) return held('supervisor_paused', 'The Owner paused the Supervisor.');
  // Before flow_disabled on purpose: a stale Autopilot confirmation shows even while the flow is off,
  // so the Owner re-confirms before turning it back on.
  if (f.dial === 'autopilot' && !f.dial_confirmed)
    return held(
      'dial_unapproved',
      "The flow's channels or caps changed since the Owner turned on Autopilot. It waits for a new confirmation.",
    );
  if (!f.enabled) return held('flow_disabled', 'The Owner has not turned this flow on.');
  if (!f.has_engine)
    return held('no_engine', 'This flow has a definition but fwd has no decision logic for it yet.');
  if (f.dial !== 'autopilot' && (f.caps?.max_usd ?? null) === null)
    return held('cap_required', `At ${f.dial} a flow needs a spend cap. Only Autopilot may run uncapped.`);
  if (capUsed(f.caps, f.spend)) {
    const period = f.caps?.period ?? 'period';
    return held('budget', `This ${period}'s cap is used up.`);
  }
  if (f.open_asks >= ASK_CAP)
    return held(
      'open_asks',
      `${f.open_asks} questions are waiting for the Owner. The flow waits for answers.`,
    );
  if (f.dry_streak >= DRY_STOP)
    return held('dormant', `${f.dry_streak} passes in a row found nothing to do. The flow is dormant.`);
  if (f.stall_streak >= STALL_STOP)
    return held('stalled', `${f.stall_streak} passes in a row changed nothing. The flow paused itself.`);
  if (f.running > 0 && !f.due)
    return { state: 'running', gate: null, reason: `${f.running} run(s) in flight.` };
  if (!f.due) return held('not_due', 'Nothing is due: no scheduled or manual run is waiting.');
  if (f.running >= f.wip_limit) return held('wip', `Already at its limit of ${f.wip_limit} run(s) at once.`);
  if (s.running_total >= s.max_concurrent)
    return held('machine_busy', `The machine is at its limit of ${s.max_concurrent} run(s) at once.`);
  return { state: 'ready', gate: null, reason: 'Due, and every gate is clear.' };
}

/**
 * Which ready flows to start now: in the order given (the Owner's priority), up to the free slots
 * on the machine. A flow admitted here takes a slot from the ones after it.
 */
export function plan(flows: { key: string; verdict: Verdict }[], s: SupervisorFacts): string[] {
  let free = Math.max(0, s.max_concurrent - s.running_total);
  const out: string[] = [];
  for (const f of flows) {
    if (free === 0) break;
    if (f.verdict.state !== 'ready') continue;
    out.push(f.key);
    free--;
  }
  return out;
}
