// FW-C-033: the Supervisor in fwd. It knows every flow shipped under flows/ (a directory with a
// stream.json), reads the facts the gates need, and answers GET /v1/supervisor. The Owner's controls
// (turn a flow on or off, pause or resume the Supervisor) live in settings('supervisor') and each one
// writes a system.config_changed event. Only fwd's single writer touches the database.
// Dispatching steps waits for the scheduler (WS-P1-004); asks as decision cards wait for WS-P1-024.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorKind, Reader, Writer } from '@fw/eventlog';
import { ownerActor, setStreamCron } from '@fw/ledger';
import * as hostMoments from '../flows/host-moments.ts';
import { loadFlow as loadLocalSaturation } from '../flows/local-saturation.ts';
import * as neighborhood from '../flows/neighborhood-activation.ts';
import { registerFlowProjects } from '../flows/projects.ts';
import type { OnFire } from '../scheduler/index.ts';
import { type FlowAi, writeFlowAi } from './ai.ts';
import { flowEngine, registerFlowStream } from './cycle.ts';
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
import {
  cronSchedule,
  type Days,
  effectivePerDay,
  type Intensity,
  IntensityError,
  parseIntensity,
  readIntensity,
  recentResults,
  scheduleCron,
} from './intensity.ts';
import { type SenderStatus, senderStatus } from './sender.ts';

export * from './gates.ts';
export { type SenderStatus, senderStatus } from './sender.ts';

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
  flows: Record<string, FlowSettings>;
}

/** One flow's Owner settings. schedule and intensity are FW-C-063. */
export interface FlowSettings {
  enabled: boolean;
  dial: Dial;
  dial_hash?: string;
  schedule?: { time: string; days: Days };
  intensity?: Intensity;
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
  // FW-C-106: fixed templates, no model, so nothing is spent; its notes go out through Frequency by hand.
  [hostMoments.FLOW_KEY]: (repoRoot, fwHome) => {
    const f = hostMoments.loadFlow(repoRoot, fwHome);
    return f && { caps: f.budget, spend: { usd: 0, turns: 0 }, outward: f.cfg.send_routes ?? null };
  },
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
  /** FW-C-063: when the flow's stream fires, read from the stream (time and days null for other crons). */
  schedule: { time: string | null; days: Days | null; cron: string; timezone: string } | null;
  /** FW-C-063: new people a day, and today's number after auto. */
  intensity: Intensity & { today: { per_day: number; why: string } };
  /**
   * FW-C-086: the AI account the flow's runs use. chosen: picked in Settings; otherwise the flow's
   * config names it. null when neither names one (routing decides).
   */
  ai: (Partial<FlowAi> & { chosen: boolean }) | null;
  /** FW-C-096: the flow this one was rolled into (its config.json merged_into), else null. */
  merged_into: string | null;
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
  /** FW-C-071: whether a sender on this Mac reads the outbox. */
  sender: SenderStatus;
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
  const raw = (o?.flows ?? {}) as Record<
    string,
    { enabled?: unknown; dial?: unknown; dial_hash?: unknown; schedule?: unknown; intensity?: unknown }
  >;
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY_RE.test(k)) continue;
    const dial = DIALS.find((d) => d === v?.dial) ?? 'draft';
    flows[k] = { enabled: v?.enabled === true, dial };
    if (dial === 'autopilot' && typeof v?.dial_hash === 'string') flows[k].dial_hash = v.dial_hash;
    const sch = v?.schedule as { time?: unknown; days?: unknown } | undefined;
    if (typeof sch?.time === 'string' && typeof sch.days === 'string') {
      try {
        scheduleCron(sch.time, sch.days);
        flows[k].schedule = { time: sch.time, days: sch.days as Days };
      } catch {
        // A broken stored schedule is dropped; the stream keeps the cron it has.
      }
    }
    if (v?.intensity && typeof v.intensity === 'object') flows[k].intensity = readIntensity(v.intensity);
  }
  return { version: 1, paused: o?.paused === true, flows };
}

function killSwitch(r: Reader): boolean {
  return (
    parse(r.get<{ value: string }>("SELECT value FROM settings WHERE key = 'kill_switch'")?.value)
      ?.engaged === true
  );
}

/** FW-C-096: the key a shipped flow was merged into (flows/<key>/config.json merged_into), else null. */
export function mergedInto(repoRoot: string, key: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(repoRoot, 'flows', key, 'config.json'), 'utf8')) as {
      merged_into?: unknown;
    };
    return typeof cfg.merged_into === 'string' && KEY_RE.test(cfg.merged_into) ? cfg.merged_into : null;
  } catch {
    return null;
  }
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
  /**
   * FW-C-097: cycles in flight right now, by flow key (the daemon's own count). Without it nothing is
   * reported as running, so a caller outside fwd (the CLI reading the database) never claims a live run.
   */
  inFlight?: () => Record<string, number>;
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
    sender: senderStatus(d.fwHome, d.now?.() ?? new Date()),
  };
}

const flowVerdicts = (d: SupervisorDeps) => verdicts(d).flows;

function verdicts(d: SupervisorDeps) {
  const now = d.now?.() ?? new Date();
  const engines = d.engines ?? ENGINES;
  const settings = readSettings(d.reader);
  const live = d.inFlight?.() ?? {};
  const sup: SupervisorFacts = {
    kill_switch: killSwitch(d.reader),
    paused: settings.paused,
    running_total: Object.values(live).reduce((a, n) => a + Math.max(0, n), 0),
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
      running: Math.max(0, live[key] ?? 0),
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
      schedule: streamSchedule(d.reader, key, stream),
      intensity: intensityView(set?.intensity, d.fwHome, key, now),
      ai: aiView(d.repoRoot, d.fwHome, key),
      merged_into: mergedInto(d.repoRoot, key),
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

/** FW-C-063: the flow's cron as the scheduler sees it: the registered stream's, else the shipped one. */
function streamSchedule(r: Reader, key: string, shipped: Record<string, unknown>): FlowView['schedule'] {
  let def: Record<string, unknown> = shipped;
  const row = r.get<{ definition: string }>(
    'SELECT definition FROM streams WHERE key = ? ORDER BY version DESC',
    [key],
  );
  if (row) def = parse(row.definition) ?? shipped;
  const t = def.trigger as { type?: unknown; cron?: unknown; timezone?: unknown } | undefined;
  if (t?.type !== 'cron' || typeof t.cron !== 'string') return null;
  const simple = cronSchedule(t.cron);
  return {
    time: simple?.time ?? null,
    days: simple?.days ?? null,
    cron: t.cron,
    timezone: typeof t.timezone === 'string' ? t.timezone : 'UTC',
  };
}

function intensityView(
  set: Intensity | undefined,
  fwHome: string,
  key: string,
  now: Date,
): FlowView['intensity'] {
  const i = readIntensity(set);
  let today: { per_day: number; why: string };
  try {
    today = effectivePerDay(i, recentResults(fwHome, key, now));
  } catch (e) {
    // Unreadable drafts: keep the Owner's number and say why, never a silent change.
    today = {
      per_day: i.per_day,
      why: `Could not read recent results (${(e as Error).message}), so ${i.per_day}.`,
    };
  }
  return { ...i, today };
}

/** FW-C-063: today's number of new people for a flow, as a cycle uses it. */
export function perDayFor(r: Reader, fwHome: string, key: string, now: Date = new Date()): number {
  return intensityView(readSettings(r).flows[key]?.intensity, fwHome, key, now).today.per_day;
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
    // FW-C-063: at the Owner's time, when one is set.
    applySchedule(w, key);
  }
  return change(w, { flow: key, enabled }, (s) => {
    if ((s.flows[key]?.enabled === true) === enabled) return false;
    s.flows[key] = { ...(s.flows[key] ?? { dial: 'draft' }), enabled };
    return true;
  });
}

/** Writes the flow's stored schedule onto its registered stream, if both exist. True when the cron moved. */
function applySchedule(w: Writer, key: string): boolean {
  const sch = readSettings(w).flows[key]?.schedule;
  const row = w.get<{ id: string }>('SELECT id FROM streams WHERE key = ? ORDER BY version DESC', [key]);
  if (!sch || !row) return false;
  return setStreamCron(w, row.id, scheduleCron(sch.time, sch.days)).changed;
}

/**
 * FW-C-063: when the flow runs. Stored in the Supervisor settings and written onto the flow's stream
 * (a new version and a stream.updated event); a stream registered later gets it when the flow is turned
 * on. rescheduled says whether the scheduler has to reload.
 */
export function setSchedule(w: Writer, repoRoot: string, key: string, time: string, days: string) {
  if (!shippedFlows(repoRoot).some((f) => f.key === key))
    throw new SupervisorError('NOT_FOUND', `no flow named ${key}`);
  try {
    scheduleCron(time, days);
  } catch (e) {
    throw new SupervisorError('INVALID', (e as Error).message);
  }
  const out = change(w, { flow: key, schedule: { time, days } }, (s) => {
    const cur = s.flows[key] ?? { enabled: false, dial: 'draft' as Dial };
    if (cur.schedule?.time === time && cur.schedule.days === days) return false;
    s.flows[key] = { ...cur, schedule: { time, days: days as Days } };
    return true;
  });
  const rescheduled = applySchedule(w, key);
  return { changed: out.changed || rescheduled, rescheduled };
}

/** FW-C-063: how many new people a day, and whether reply rates may move it within min..max. */
export function setIntensity(w: Writer, repoRoot: string, key: string, body: Record<string, unknown>) {
  if (!shippedFlows(repoRoot).some((f) => f.key === key))
    throw new SupervisorError('NOT_FOUND', `no flow named ${key}`);
  let next: Intensity;
  try {
    next = parseIntensity(body);
  } catch (e) {
    if (e instanceof IntensityError) throw new SupervisorError('INVALID', e.message);
    throw e;
  }
  return change(w, { flow: key, intensity: next }, (s) => {
    const cur = s.flows[key] ?? { enabled: false, dial: 'draft' as Dial };
    if (JSON.stringify(cur.intensity) === JSON.stringify(next)) return false;
    s.flows[key] = { ...cur, intensity: next };
    return true;
  });
}

function aiView(repoRoot: string, fwHome: string, key: string): FlowView['ai'] {
  const e = flowEngine(repoRoot, key, fwHome);
  if (e.adapter !== 'claude' && e.adapter !== 'codex') return null;
  return { adapter: e.adapter, ...(e.auth ? { auth: e.auth } : {}), chosen: e.chosen === true };
}

/** FW-C-086: which AI account a flow uses, from Settings. body { account }. */
export function setFlowAi(repoRoot: string, fwHome: string, key: string, body: Record<string, unknown>) {
  if (!shippedFlows(repoRoot).some((f) => f.key === key))
    throw new SupervisorError('NOT_FOUND', `no flow named ${key}`);
  try {
    return writeFlowAi(fwHome, key, body);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'INVALID')
      throw new SupervisorError('INVALID', (e as Error).message);
    throw e;
  }
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
    const { dial_hash: _old, ...keep } = cur;
    const next: FlowSettings = { ...keep, dial };
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
  /** FW-C-104: an approved email batch on a flow whose config sets sequence.email_batch_approval. */
  batch?: boolean;
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
  // FW-C-052: a hunt draft for a contact form, a social profile or an event platform is sent by hand:
  // those sites ban automated messages, so it never goes to the outbox, approved or not.
  const via = item.lead?.send_via;
  if (typeof via === 'string' && via !== 'email')
    return held('send_by_hand', `This draft is for ${via.replace('_', ' ')}, which the Owner sends by hand.`);
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
    if (stop === 'draft' && !(o.batch && via === 'email'))
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
