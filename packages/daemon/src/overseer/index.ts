// FW-C-033: the Supervisor in fwd. It knows every flow shipped under flows/ (a directory with a
// stream.json), reads the facts the gates need, and answers GET /v1/supervisor. The Owner's controls
// (turn a flow on or off, pause or resume the Supervisor) live in settings('supervisor') and each one
// writes a system.config_changed event. Only fwd's single writer touches the database.
// Dispatching steps waits for the scheduler (WS-P1-004); asks as decision cards wait for WS-P1-024.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorKind, Reader, Writer } from '@fw/eventlog';
import { ownerActor } from '@fw/ledger';
import { loadFlow as loadLocalSaturation } from '../flows/local-saturation.ts';
import * as neighborhood from '../flows/neighborhood-activation.ts';
import { registerFlowProjects } from '../flows/projects.ts';
import type { OnFire } from '../scheduler/index.ts';
import { registerFlowStream } from './cycle.ts';
import {
  type Caps,
  capUsed,
  DIALS,
  type Dial,
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
  /** dial_hash: the confirm hash the Owner accepted when turning on Autopilot (FW-C-035). */
  flows: Record<string, { enabled: boolean; dial: Dial; dial_hash?: string }>;
}

/** What an engine (a module under src/flows/) tells the Supervisor about its flow. */
export interface EngineFacts {
  caps: Caps | null;
  spend: Spend | null;
  /** Where the flow's finished items go (its channels). Autopilot is confirmed against these. */
  outward: unknown;
}
type Engine = (repoRoot: string, fwHome: string, now: Date) => EngineFacts | null;

/** Flows fwd has decision logic for. A shipped flow missing here is held by no_engine. */
export const ENGINES: Record<string, Engine> = {
  'local-saturation': (repoRoot, fwHome, now) => {
    const f = loadLocalSaturation(repoRoot, fwHome, now);
    if (!f) return null;
    const spend = { usd: f.state.spend.usd, turns: f.state.spend.turns };
    return { caps: f.budget, spend, outward: f.cfg.channels ?? null };
  },
  'neighborhood-activation': (repoRoot, fwHome, now) => {
    const f = neighborhood.loadFlow(repoRoot, fwHome, now);
    if (!f) return null;
    const { usd, turns } = f.state.spend;
    // The flow's own decide() knows when its spend period has rolled over. When it does not pause for
    // budget, spend recorded in an old period no longer counts against this one.
    const paused = neighborhood.decide(f.cfg, f.state, f.budget, now).kind === 'paused_budget';
    const spend = paused || !capUsed(f.budget, { usd, turns }) ? { usd, turns } : { usd: 0, turns: 0 };
    return { caps: f.budget, spend, outward: f.cfg.send_routes ?? null };
  },
};

/** JSON with sorted keys, so the same facts always hash the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * The hash the Owner confirms to turn on Autopilot: the flow's channels and caps. Change either and
 * the old confirmation no longer matches, so the flow holds by dial_unapproved.
 */
export function confirmHash(key: string, facts: Pick<EngineFacts, 'caps' | 'outward'>): string {
  const c = facts.caps;
  const caps = c ? { max_usd: c.max_usd, max_turns: c.max_turns, period: c.period } : null;
  return createHash('sha256')
    .update(canonical({ flow: key, channels: facts.outward ?? null, caps }))
    .digest('hex');
}

export interface FlowView {
  key: string;
  name: string;
  enabled: boolean;
  dial: Dial;
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
  const raw = (o?.flows ?? {}) as Record<string, { enabled?: unknown; dial?: unknown; dial_hash?: unknown }>;
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY_RE.test(k)) continue;
    const dial = DIALS.find((d) => d === v?.dial) ?? 'draft';
    flows[k] = { enabled: v?.enabled === true, dial };
    if (dial === 'autopilot' && typeof v?.dial_hash === 'string') flows[k].dial_hash = v.dial_hash;
  }
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
  /** The flow a scheduled fire is asking about: the fire itself makes it due. */
  dueFlow?: string;
}

export function supervisorView(d: SupervisorDeps): SupervisorView {
  const { sup, flows } = verdicts(d);
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

const flowVerdicts = (d: SupervisorDeps) => verdicts(d).flows;

function verdicts(d: SupervisorDeps) {
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
    const set = settings.flows[key];
    const dial = set?.dial ?? 'draft';
    const f: FlowFacts = {
      key,
      enabled: set?.enabled === true,
      has_engine: facts !== null,
      dial,
      dial_confirmed: dial === 'autopilot' && facts !== null && set?.dial_hash === confirmHash(key, facts),
      caps: facts?.caps ?? null,
      spend: facts?.spend ?? null,
      open_asks: 0,
      dry_streak: 0,
      stall_streak: 0,
      running: 0,
      wip_limit: Number.isInteger(wip) && wip > 0 ? wip : 1,
      due: key === d.dueFlow,
    };
    let verdict = decide(f, sup);
    // A broken engine is a deny with its reason, never a silent pass (a gate failure is a deny).
    if (engineError && verdict.gate === 'no_engine')
      verdict = { ...verdict, reason: `The flow's logic failed: ${engineError}` };
    const view: FlowView = {
      key,
      name: typeof stream.name === 'string' ? stream.name : key,
      enabled: f.enabled,
      dial,
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
  return { sup, flows };
}

/**
 * FW-C-036: the scheduler's onFire. A fire of a stream whose key names a shipped flow is admitted
 * only when the Supervisor would let that flow run now; otherwise it is held and the reason starts
 * with the gate. Streams that are not flows are admitted as before. A failure here holds the fire
 * (the scheduler records a throw as held).
 */
export function createSupervisorOnFire(d: SupervisorDeps): OnFire {
  return async (fire) => {
    if (!shippedFlows(d.repoRoot).some((f) => f.key === fire.streamKey)) return { outcome: 'admit' };
    const verdict = flowVerdicts({ ...d, dueFlow: fire.streamKey }).find(
      (x) => x.view.key === fire.streamKey,
    )!.verdict;
    if (verdict.state === 'ready') return { outcome: 'admit' };
    return { outcome: 'hold', reason: `${verdict.gate ?? verdict.state}: ${verdict.reason}` };
  };
}

export class SupervisorError extends Error {
  // A plain field, not a parameter property: fwd runs this file with Node's type stripping.
  readonly code: 'NOT_FOUND' | 'INVALID' | 'CONFIRM_REQUIRED' | 'CONFLICT';
  readonly details: Record<string, unknown>;
  constructor(
    code: 'NOT_FOUND' | 'INVALID' | 'CONFIRM_REQUIRED' | 'CONFLICT',
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SupervisorError';
    this.code = code;
    this.details = details;
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
  // Turning a flow on also files it under its project and brand (flows/<key>/project.json).
  if (enabled) {
    registerFlowProjects(w, repoRoot, () => {}, key);
    // FW-C-038: and registers its stream, so the scheduler fires it.
    registerFlowStream(w, repoRoot, key);
  }
  return change(w, { flow: key, enabled }, (s) => {
    if ((s.flows[key]?.enabled === true) === enabled) return false;
    s.flows[key] = { ...(s.flows[key] ?? { dial: 'draft' }), enabled };
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

/**
 * Set a flow's dial (FW-C-035). Autopilot needs the Owner to pass the flow's current confirm hash,
 * which binds the choice to its channels and caps; without it, or with a stale one, nothing changes
 * and the error names the hash to confirm. Leaving Autopilot drops the confirmation.
 */
export function setDial(
  w: Writer,
  repoRoot: string,
  fwHome: string,
  key: string,
  stop: string,
  confirm?: string,
  engines: Record<string, Engine> = ENGINES,
  now: Date = new Date(),
) {
  if (!shippedFlows(repoRoot).some((f) => f.key === key))
    throw new SupervisorError('NOT_FOUND', `no flow named ${key}`);
  const dial = DIALS.find((d) => d === stop);
  if (!dial) throw new SupervisorError('INVALID', `stop must be one of ${DIALS.join(', ')}`);
  let hash: string | undefined;
  if (dial === 'autopilot') {
    const facts = engines[key]?.(repoRoot, fwHome, now) ?? null;
    if (!facts)
      throw new SupervisorError('INVALID', `${key} has no decision logic, so it cannot run on Autopilot`);
    hash = confirmHash(key, facts);
    if (confirm !== hash)
      throw new SupervisorError(
        'CONFIRM_REQUIRED',
        `Autopilot for ${key} is bound to its channels and caps. Confirm with this hash.`,
        { confirm_hash: hash, flow: key },
      );
  }
  return change(w, { flow: key, dial, ...(hash ? { confirm_hash: hash } : {}) }, (s) => {
    const cur = s.flows[key] ?? { enabled: false, dial: 'draft' as Dial };
    if (cur.dial === dial && cur.dial_hash === hash) return false;
    const next: SupervisorSettings['flows'][string] = { enabled: cur.enabled, dial };
    if (hash) next.dial_hash = hash;
    s.flows[key] = next;
    return true;
  });
}

export interface HandOffItem {
  id: string;
  channel: string;
  body: string;
  /** FW-C-041: who the item is for and where that came from, for the sending app. */
  lead?: Record<string, unknown>;
}
export type HandOffResult = { outcome: 'queued'; path: string } | { outcome: 'held'; reason: string };

const channelKeys = (outward: unknown): string[] => {
  if (Array.isArray(outward))
    return outward
      .map((c) => (c && typeof c === 'object' ? (c as { key?: unknown }).key : c))
      .filter((k): k is string => typeof k === 'string');
  return outward && typeof outward === 'object' ? Object.keys(outward) : [];
};

/**
 * FW-C-037: hand one finished item of a flow at confirmed Autopilot to the outbox, a folder a sending
 * app outside Core reads. Core never sends: this writes one local file and one notification.queued
 * event. Anything else holds the item, and the reason starts with why.
 */
export function handOff(o: {
  writer: Writer;
  repoRoot: string;
  fwHome: string;
  flow: string;
  item: HandOffItem;
  engines?: Record<string, Engine>;
  now?: Date;
  /** FW-C-046: the Owner approved this item (Copilot or Autopilot), so the autopilot gate does not apply. */
  approved?: boolean;
}): HandOffResult {
  const { writer: w, flow, item } = o;
  if (!shippedFlows(o.repoRoot).some((f) => f.key === flow))
    throw new SupervisorError('NOT_FOUND', `no flow named ${flow}`);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(item.id))
    throw new SupervisorError('INVALID', 'item id must be 1-100 letters, digits, _ or -');
  const held = (why: string, words: string): HandOffResult => ({
    outcome: 'held',
    reason: `${why}: ${words}`,
  });
  if (killSwitch(w)) return held('kill_switch', 'The kill switch is engaged.');
  const s = readSettings(w);
  if (s.paused) return held('supervisor_paused', 'The Owner paused the Supervisor.');
  let facts: EngineFacts | null = null;
  try {
    facts = (o.engines ?? ENGINES)[flow]?.(o.repoRoot, o.fwHome, o.now ?? new Date()) ?? null;
  } catch {
    facts = null;
  }
  if (!facts) return held('no_engine', 'The flow has no working logic.');
  const set = s.flows[flow];
  if (set?.enabled !== true) return held('flow_disabled', 'The Owner has not turned this flow on.');
  const stop = set.dial ?? 'draft';
  const hash = confirmHash(flow, facts);
  if (o.approved) {
    // FW-C-046: the Owner approved this one item. Copilot and Autopilot both allow that; at Draft the
    // Owner sends by hand, so nothing goes to the outbox.
    if (stop === 'draft')
      return held(
        'needs_copilot',
        'At draft the Owner sends each item by hand; set the flow to copilot to approve items here.',
      );
  } else {
    if (stop !== 'autopilot') return held('needs_owner', `At ${stop} every item waits for the Owner.`);
    if (set.dial_hash !== hash)
      return held(
        'dial_unapproved',
        "The flow's channels or caps changed since the Owner confirmed Autopilot.",
      );
  }
  if (!channelKeys(facts.outward).includes(item.channel))
    return held('unknown_channel', `${flow} does not list ${item.channel}.`);
  const dir = join(o.fwHome, 'outbox', flow);
  const path = join(dir, `${item.id}.json`);
  const dedupe_key = `flow_handoff:${flow}:${item.id}`;
  // Queued once means queued forever: a sending app may already have taken the file, so the event, not
  // the file, decides. Writing the file again would send the item twice.
  if (
    existsSync(path) ||
    w.get("SELECT 1 FROM events WHERE type = 'notification.queued' AND idempotency_key = ?", [dedupe_key])
  )
    return { outcome: 'queued', path };
  const sha256 = createHash('sha256').update(item.body).digest('hex');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ flow, id: item.id, channel: item.channel, body: item.body, ...(item.lead ? { lead: item.lead } : {}), confirm_hash: hash, sha256 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  w.appendEvent({
    type: 'notification.queued',
    actor_kind: 'system',
    actor_id: 'supervisor',
    idempotency_key: dedupe_key,
    payload: {
      notification_id: dedupe_key,
      channel: item.channel,
      kind: 'flow_handoff',
      priority: 'normal',
      dedupe_key,
      flow,
      item_id: item.id,
      sha256,
    },
  });
  renameSync(tmp, path);
  return { outcome: 'queued', path };
}
