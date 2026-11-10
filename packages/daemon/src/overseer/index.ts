// FW-C-033: the Supervisor in fwd. It knows every flow shipped under flows/ (a directory with a
// stream.json), reads the facts the gates need, and answers GET /v1/supervisor. The Owner's controls
// (turn a flow on or off, pause or resume the Supervisor) live in settings('supervisor') and each one
// writes a system.config_changed event. Only fwd's single writer touches the database.
// Dispatching steps waits for the scheduler (WS-P1-004); asks as decision cards wait for WS-P1-024.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorKind, Reader, Writer } from '@fw/eventlog';
import { ownerActor } from '@fw/ledger';
import { loadFlow as loadLocalSaturation } from '../flows/local-saturation.ts';
import {
  type Caps,
  decide,
  type FlowFacts,
  GATES,
  plan,
  type Spend,
  type SupervisorFacts,
  type Verdict,
} from './gates.ts';

export * from './gates.ts';

export const SETTINGS_KEY = 'supervisor';
/**
 * Runs at once on this machine. Owner decision (10 Nov): two subscription sign-ins, several agents
 * on each, so two runs per sign-in. Per-lane slots arrive with dispatch, once a run names its lane.
 */
export const DEFAULT_MAX_CONCURRENT = 4;

export interface SupervisorSettings {
  version: 1;
  paused: boolean;
  flows: Record<string, { enabled: boolean }>;
}

/** What an engine (a module under src/flows/) tells the Supervisor about its flow. */
export interface EngineFacts {
  caps: Caps | null;
  spend: Spend | null;
}
type Engine = (repoRoot: string, fwHome: string, now: Date) => EngineFacts | null;

/** Flows fwd has decision logic for. A shipped flow missing here is held by no_engine. */
export const ENGINES: Record<string, Engine> = {
  'local-saturation': (repoRoot, fwHome, now) => {
    const f = loadLocalSaturation(repoRoot, fwHome, now);
    return f ? { caps: f.budget, spend: { usd: f.state.spend.usd, turns: f.state.spend.turns } } : null;
  },
};

export interface FlowView {
  key: string;
  name: string;
  enabled: boolean;
  tier: string;
  state: Verdict['state'];
  gate: Verdict['gate'];
  reason: string;
  budget: (Caps & { spent_usd: number | null; used_turns: number | null }) | null;
  open_asks: number;
}

export interface SupervisorView {
  kill_switch: boolean;
  paused: boolean;
  max_concurrent: number;
  running: number;
  gates: readonly string[];
  flows: FlowView[];
  /** Flows that would start now, in order. Nothing starts them until the scheduler lands. */
  next: string[];
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function parse(v: string | undefined): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function readSettings(r: Reader): SupervisorSettings {
  const o = parse(
    r.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY])?.value,
  );
  const flows: SupervisorSettings['flows'] = {};
  const raw = (o?.flows ?? {}) as Record<string, { enabled?: unknown }>;
  for (const [k, v] of Object.entries(raw)) if (KEY_RE.test(k)) flows[k] = { enabled: v?.enabled === true };
  return { version: 1, paused: o?.paused === true, flows };
}

function killSwitch(r: Reader): boolean {
  return (
    parse(r.get<{ value: string }>("SELECT value FROM settings WHERE key = 'kill_switch'")?.value)
      ?.engaged === true
  );
}

/** Every flow that ships a stream.json under flows/, sorted by key. */
export function shippedFlows(repoRoot: string): { key: string; stream: Record<string, unknown> }[] {
  const dir = join(repoRoot, 'flows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && KEY_RE.test(e.name) && existsSync(join(dir, e.name, 'stream.json')))
    .map((e) => e.name)
    .sort()
    .map((key) => {
      let stream: Record<string, unknown> = {};
      try {
        stream = JSON.parse(readFileSync(join(dir, key, 'stream.json'), 'utf8')) as Record<string, unknown>;
      } catch {
        // An unreadable definition still lists the flow; it has no name and no engine facts.
      }
      return { key, stream };
    });
}

export interface SupervisorDeps {
  reader: Reader;
  repoRoot: string;
  fwHome: string;
  now?: () => Date;
  maxConcurrent?: number;
  engines?: Record<string, Engine>;
}

export function supervisorView(d: SupervisorDeps): SupervisorView {
  const now = d.now?.() ?? new Date();
  const engines = d.engines ?? ENGINES;
  const settings = readSettings(d.reader);
  const sup: SupervisorFacts = {
    kill_switch: killSwitch(d.reader),
    paused: settings.paused,
    running_total: 0,
    max_concurrent: d.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  };
  const flows = shippedFlows(d.repoRoot).map(({ key, stream }) => {
    const engine = engines[key];
    let facts: EngineFacts | null = null;
    let engineError: string | null = null;
    try {
      facts = engine ? engine(d.repoRoot, d.fwHome, now) : null;
    } catch (e) {
      engineError = (e as Error).message;
    }
    const wip = Number(stream.wip_limit);
    const f: FlowFacts = {
      key,
      enabled: settings.flows[key]?.enabled === true,
      has_engine: facts !== null,
      caps: facts?.caps ?? null,
      spend: facts?.spend ?? null,
      open_asks: 0,
      dry_streak: 0,
      stall_streak: 0,
      running: 0,
      wip_limit: Number.isInteger(wip) && wip > 0 ? wip : 1,
      due: false,
    };
    let verdict = decide(f, sup);
    // A broken engine is a deny with its reason, never a silent pass (a gate failure is a deny).
    if (engineError && verdict.gate === 'no_engine')
      verdict = { ...verdict, reason: `The flow's logic failed: ${engineError}` };
    const view: FlowView = {
      key,
      name: typeof stream.name === 'string' ? stream.name : key,
      enabled: f.enabled,
      tier: typeof stream.default_tier === 'string' ? stream.default_tier : 'L1',
      state: verdict.state,
      gate: verdict.gate,
      reason: verdict.reason,
      budget: f.caps
        ? { ...f.caps, spent_usd: f.spend?.usd ?? null, used_turns: f.spend?.turns ?? null }
        : null,
      open_asks: f.open_asks,
    };
    return { view, verdict };
  });
  return {
    kill_switch: sup.kill_switch,
    paused: sup.paused,
    max_concurrent: sup.max_concurrent,
    running: sup.running_total,
    gates: GATES,
    flows: flows.map((x) => x.view),
    next: plan(
      flows.map((x) => ({ key: x.view.key, verdict: x.verdict })),
      sup,
    ),
  };
}

export class SupervisorError extends Error {
  constructor(
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'SupervisorError';
  }
}

function actor(w: Writer): { kind: ActorKind; id: string } {
  try {
    return ownerActor(w);
  } catch {
    // No Owner bootstrapped yet: fwd records the change on the CLI token's behalf.
    return { kind: 'system', id: 'fwd' };
  }
}

/** One Owner control, in one transaction: the new settings and the event that names the change. */
function change(
  w: Writer,
  what: Record<string, unknown>,
  edit: (s: SupervisorSettings) => boolean,
): { changed: boolean; settings: SupervisorSettings } {
  return w.transaction((tx) => {
    const s = readSettings(tx);
    if (!edit(s)) return { changed: false, settings: s };
    const by = actor(tx);
    tx.run(
      `INSERT INTO settings(key, value, trust_tier, description, updated_by) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      [
        SETTINGS_KEY,
        JSON.stringify(s),
        'The Supervisor: which flows are on, and whether it is paused',
        by.id,
      ],
    );
    const version = tx.get<{ version: number }>('SELECT version FROM settings WHERE key = ?', [
      SETTINGS_KEY,
    ])!.version;
    tx.appendEvent({
      type: 'system.config_changed',
      actor_kind: by.kind,
      actor_id: by.id,
      idempotency_key: `${SETTINGS_KEY}:${version}`,
      payload: { setting: SETTINGS_KEY, version, requested_with: 'cli_token', ...what },
    });
    return { changed: true, settings: s };
  });
}

export function setFlowEnabled(w: Writer, repoRoot: string, key: string, enabled: boolean) {
  if (!shippedFlows(repoRoot).some((f) => f.key === key))
    throw new SupervisorError('NOT_FOUND', `no flow named ${key}`);
  return change(w, { flow: key, enabled }, (s) => {
    if ((s.flows[key]?.enabled === true) === enabled) return false;
    s.flows[key] = { enabled };
    return true;
  });
}

export function setPaused(w: Writer, paused: boolean) {
  return change(w, { paused }, (s) => {
    if (s.paused === paused) return false;
    s.paused = paused;
    return true;
  });
}
