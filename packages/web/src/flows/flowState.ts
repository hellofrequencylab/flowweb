// FW-C-070: the Supervisor's words for a flow's state, shared by the Flows page and its controls table.
import type { SupervisorDial, SupervisorFlow, SupervisorGate } from '../api/types';
import type { Loop } from '../ui-kit/loop';
import type { StatusSpec } from '../ui-kit/status';

/** One word per gate, so a held flow always says why in plain English. */
const GATE: Record<SupervisorGate, StatusSpec> = {
  kill_switch: { word: 'Stopped by the kill switch', tone: 'stop', icon: 'halted' },
  supervisor_paused: { word: 'Supervisor paused', tone: 'warn', icon: 'paused' },
  flow_disabled: { word: 'Off', tone: 'neutral', icon: 'stopped' },
  no_engine: { word: 'No logic yet', tone: 'unknown', icon: 'unknown' },
  dial_unapproved: { word: 'Autopilot needs your confirm', tone: 'attention', icon: 'waiting' },
  cap_required: { word: 'Needs a spend cap', tone: 'warn', icon: 'blocked' },
  budget: { word: 'Spend cap reached', tone: 'warn', icon: 'paused' },
  open_asks: { word: 'Waiting on your answers', tone: 'attention', icon: 'waiting' },
  dormant: { word: 'Dormant: nothing to do', tone: 'neutral', icon: 'paused' },
  stalled: { word: 'Stalled: paused itself', tone: 'warn', icon: 'blocked' },
  wip: { word: 'At its run limit', tone: 'neutral', icon: 'clock' },
  not_due: { word: 'On, nothing due', tone: 'ok', icon: 'clock' },
  machine_busy: { word: 'Machine busy', tone: 'neutral', icon: 'clock' },
};

/** The dial, in the Owner's words. Core never sends at any stop. */
export const DIAL: Record<SupervisorDial, string> = {
  draft: 'Draft',
  copilot: 'Copilot',
  autopilot: 'Autopilot',
};

export function flowSpec(f: SupervisorFlow): StatusSpec {
  if (f.state === 'running') return { word: 'Running', tone: 'active', icon: 'running' };
  if (f.state === 'ready') return { word: 'Ready to run', tone: 'active', icon: 'ready' };
  return f.gate ? GATE[f.gate] : { word: 'Held', tone: 'unknown', icon: 'unknown' };
}

/**
 * FW-C-098: a flow's loop state, the one look every meter of the flow takes. Running is working; on and
 * between cycles is connected; switched off, paused, dormant or waiting on your answers is waiting; a
 * missing piece (no logic, no cap, cap used up, stalled, Autopilot unconfirmed) is broken.
 */
export function flowLoop(f: SupervisorFlow | null | undefined): Loop {
  if (!f) return 'waiting';
  if (f.state === 'running') return 'working';
  if (f.state === 'ready') return 'connected';
  switch (f.gate) {
    case 'not_due':
    case 'wip':
    case 'machine_busy':
      return 'connected';
    case 'no_engine':
    case 'cap_required':
    case 'budget':
    case 'stalled':
    case 'dial_unapproved':
      return 'broken';
    default:
      return 'waiting';
  }
}
