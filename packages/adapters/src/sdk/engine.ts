// The run engine shared by every adapter. A vendor driver supplies the command line and a parser
// that turns stdout lines into VendorItems; the engine owns everything that must not differ by
// vendor: process group, scrubbed env, caps, redaction, step numbering, cost and the run result.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsage, costRecord, estimateUsd, type Pricing, type TokenUsage, ZERO_USAGE } from './cost.ts';
import { AdapterError, isAdapterError } from './errors.ts';
import { collectGitChanges } from './git.ts';
import { appendInjection, detectInjection } from './injection.ts';
import { previewOf } from './lines.ts';
import { buildSandboxEnv, type GroupProcess, spawnGroup } from './process.ts';
import { AsyncQueue } from './queue.ts';
import { Redactor } from './redact.ts';
import type {
  AdapterErrorCode,
  AdapterEvent,
  AdapterRun,
  ArtifactKind,
  ArtifactPointer,
  CapName,
  FailureClass,
  Fingerprint,
  InjectionSuspected,
  RunMeta,
  RunResult,
  RunStatus,
  RunStep,
  StartOptions,
  StepKind,
  Vendor,
  VendorAdapterInput,
} from './types.ts';

/** What a vendor parser extracts from one stdout line. Everything in here is untrusted data. */
export type VendorItem =
  | { kind: 'session'; session_id: string; model?: string }
  | {
      kind: 'turn';
      text: string;
      /** Turns sharing a message id count once; usage for an id is cumulative. */
      message_id?: string;
      usage?: TokenUsage;
    }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; text: string; is_error: boolean }
  | {
      kind: 'result';
      ok: boolean;
      subtype?: string;
      usd?: number;
      usage?: TokenUsage;
      session_id?: string;
      summary?: string;
      /** Structured agent report: summary, claims, followups, stop_requests, tests. Sanitized here. */
      report?: unknown;
      /** Agent-claimed artifact pointers. Sanitized here; the kernel verifies them. */
      artifacts?: unknown;
    }
  | { kind: 'error'; code: AdapterErrorCode; message: string; raw?: string };

export type LineParser = (line: string) => VendorItem[];

export interface PreparedRun {
  command: string;
  args: string[];
  stdin?: string;
  extraEnv?: Record<string, string>;
  /** Credential env actually passed to the child (validated by the driver). */
  credentialEnv: Record<string, string>;
  fingerprint: Fingerprint | null;
  model: string;
  /** Session id known before the run starts, if the driver assigns one. */
  session_id?: string;
  /** The prompt as sent, recorded as step 0. */
  prompt: string;
}

export interface Driver {
  name: string;
  vendor: Vendor;
  pricing: Pricing;
  prepare(input: VendorAdapterInput, opts: StartOptions): Promise<PreparedRun>;
  createParser(): LineParser;
}

const MAX_STEP_CONTENT = 64 * 1024;
const STDERR_TAIL = 20;
const DEFAULT_GRACE_MS = 1500;
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'pull_request',
  'commit',
  'message_id',
  'file',
  'report',
  'deploy',
  'calendar_hold',
  'ticket_reply',
  'email_draft',
];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable tcl_ id for a vendor tool call id (run-result requires ^tcl_[0-9A-Za-z]{4,40}$). */
export function toolCallId(vendorId: string): string {
  return `tcl_${sha256(vendorId).slice(0, 24)}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 15)}...[truncated]` : s;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 ? clip(v, max) : undefined;
}

function strList(v: unknown, max: number, limit = 100): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => clip(x, max));
  return out.slice(0, limit);
}

export function sanitizeArtifacts(v: unknown): ArtifactPointer[] {
  if (!Array.isArray(v)) return [];
  const out: ArtifactPointer[] = [];
  for (const a of v) {
    if (a === null || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    if (!ARTIFACT_KINDS.includes(o.kind as ArtifactKind)) continue;
    if (typeof o.ref !== 'string' || o.ref.length < 1 || o.ref.length > 2048) continue;
    const p: ArtifactPointer = { kind: o.kind as ArtifactKind, ref: o.ref };
    if (typeof o.sha === 'string' && /^[0-9a-f]{40,64}$/.test(o.sha)) p.sha = o.sha;
    if (typeof o.title === 'string') p.title = clip(o.title, 300);
    out.push(p);
  }
  return out.slice(0, 50);
}

interface SanitizedReport {
  summary?: string;
  claims?: NonNullable<RunResult['claims']>;
  followups?: string[];
  stop_requests?: NonNullable<RunResult['stop_requests']>;
  tests_added?: string[];
  tests_modified?: string[];
  injection_suspected?: InjectionSuspected;
}

export function sanitizeReport(v: unknown): SanitizedReport {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const r: SanitizedReport = {};
  const summary = str(o.summary, 2000);
  if (summary) r.summary = summary;
  if (Array.isArray(o.claims)) {
    r.claims = [];
    for (const c of o.claims) {
      if (c === null || typeof c !== 'object') continue;
      const x = c as Record<string, unknown>;
      if (typeof x.acceptance_id !== 'string' || !/^AC[0-9]{1,3}$/.test(x.acceptance_id)) continue;
      if (typeof x.claim !== 'string') continue;
      const claim: NonNullable<RunResult['claims']>[number] = {
        acceptance_id: x.acceptance_id,
        claim: clip(x.claim, 1000),
      };
      if (typeof x.evidence_ref === 'string' && x.evidence_ref.length >= 1 && x.evidence_ref.length <= 2048)
        claim.evidence_ref = x.evidence_ref;
      if (typeof x.tool_call_id === 'string' && /^tcl_[0-9A-Za-z]{4,40}$/.test(x.tool_call_id))
        claim.tool_call_id = x.tool_call_id;
      r.claims.push(claim);
    }
  }
  const followups = strList(o.followups, 300);
  if (followups) r.followups = followups;
  if (Array.isArray(o.stop_requests)) {
    r.stop_requests = [];
    for (const s of o.stop_requests) {
      if (s === null || typeof s !== 'object') continue;
      const x = s as Record<string, unknown>;
      if (typeof x.condition !== 'string' || !x.condition) continue;
      const sr: NonNullable<RunResult['stop_requests']>[number] = { condition: clip(x.condition, 500) };
      if (typeof x.andon === 'boolean') sr.andon = x.andon;
      if (typeof x.detail === 'string') sr.detail = clip(x.detail, 500);
      r.stop_requests.push(sr);
    }
  }
  const ta = strList(o.tests_added, 500);
  if (ta) r.tests_added = ta;
  const tm = strList(o.tests_modified, 500);
  if (tm) r.tests_modified = tm;
  if (Array.isArray(o.injection_suspected)) {
    r.injection_suspected = [];
    for (const f of o.injection_suspected) {
      if (f === null || typeof f !== 'object') continue;
      const x = f as Record<string, unknown>;
      if (typeof x.source !== 'string' || typeof x.fragment !== 'string' || typeof x.location !== 'string')
        continue;
      if (!x.source) continue;
      r.injection_suspected.push({
        source: clip(x.source, 120),
        fragment: clip(x.fragment, 200),
        location: clip(x.location, 300),
      });
    }
  }
  return r;
}

function wallClockMs(input: VendorAdapterInput): number {
  let ms = input.caps.max_wall_clock_s * 1000;
  if (typeof input.budget.max_minutes === 'number' && input.budget.max_minutes > 0)
    ms = Math.min(ms, input.budget.max_minutes * 60_000);
  return ms;
}

function turnLimit(input: VendorAdapterInput): number {
  let n = input.caps.max_turns;
  if (typeof input.budget.max_turns === 'number') n = Math.min(n, input.budget.max_turns);
  return n;
}

/** Start a run through a driver. Never throws; every failure ends up in the result. */
export function startRun(driver: Driver, input: VendorAdapterInput, opts: StartOptions = {}): AdapterRun {
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const queue = new AsyncQueue<AdapterEvent>();
  let redactor = new Redactor(Object.values(opts.credentialEnv ?? {}));
  const graceMs = opts.killGraceMs ?? DEFAULT_GRACE_MS;
  const startedAt = iso();
  const stepPrefix = `stp_${input.run_id.slice(4)}_`;

  let proc: GroupProcess | null = null;
  let seq = 0;
  let turns = 0;
  let toolCalls = 0;
  let errorCount = 0;
  let usage: TokenUsage = { ...ZERO_USAGE };
  let runningUsd = 0;
  let sessionId: string | undefined;
  let model = 'unknown';
  let fingerprint: Fingerprint | null = null;
  let resultItem: Extract<VendorItem, { kind: 'result' }> | undefined;
  let lastTurnText = '';
  let capBreach: RunMeta['cap_breach'] = null;
  let killedReason: string | null = null;
  let refusal: AdapterError | null = null;
  const stderrTail: string[] = [];
  const injection: InjectionSuspected = [];
  const commands: NonNullable<RunResult['commands_run']> = [];
  const messageUsage = new Map<string, TokenUsage>();
  const toolNames = new Map<string, string>();

  const emit = (e: AdapterEvent) => queue.push(redactor.deep(e));

  const emitError = (code: AdapterErrorCode, message: string, raw?: string) => {
    errorCount++;
    const e: AdapterEvent = { type: 'error', code, message: clip(message, 500), at: iso() };
    if (raw !== undefined) {
      e.preview = previewOf(redactor.text(raw));
      e.byte_length = Buffer.byteLength(raw);
    }
    emit(e);
  };

  const emitStep = (
    kind: StepKind,
    content: string,
    extra: Partial<
      Pick<RunStep, 'tokens_in' | 'tokens_out' | 'cost_usd' | 'tool_name' | 'tool_call_id' | 'is_error'>
    > = {},
  ): RunStep => {
    const text = clip(redactor.text(content), MAX_STEP_CONTENT);
    const at = iso();
    const step: RunStep = {
      id: `${stepPrefix}${String(seq).padStart(4, '0')}`,
      run_id: input.run_id,
      seq,
      kind,
      content_ref: null,
      content_hash: sha256(text),
      tokens_in: extra.tokens_in ?? 0,
      tokens_out: extra.tokens_out ?? 0,
      cost_usd: extra.cost_usd ?? 0,
      started_at: at,
      ended_at: at,
      content: text,
    };
    if (extra.tool_name !== undefined) step.tool_name = extra.tool_name;
    if (extra.tool_call_id !== undefined) step.tool_call_id = extra.tool_call_id;
    if (extra.is_error !== undefined) step.is_error = extra.is_error;
    seq++;
    emit({ type: 'step', step });
    return step;
  };

  const breach = (cap: CapName, limit: number, observed: number) => {
    if (capBreach || killedReason) return;
    capBreach = { cap, limit, observed };
    emit({ type: 'cap_breach', cap, limit, observed, at: iso() });
    void proc?.kill(graceMs);
  };

  const checkCaps = () => {
    const tl = turnLimit(input);
    if (turns > tl) return breach('turns', tl, turns);
    const maxTokens = input.budget.max_tokens;
    const tokens = usage.input_tokens + usage.output_tokens;
    if (typeof maxTokens === 'number' && tokens > maxTokens) return breach('tokens', maxTokens, tokens);
    const maxUsd = input.budget.max_usd;
    if (typeof maxUsd === 'number' && runningUsd > maxUsd) return breach('usd', maxUsd, runningUsd);
  };

  const handle = (item: VendorItem) => {
    switch (item.kind) {
      case 'session': {
        sessionId = item.session_id;
        if (item.model) model = item.model;
        emit({
          type: 'session',
          session_id: item.session_id,
          ...(item.model ? { model: item.model } : {}),
          at: iso(),
        });
        return;
      }
      case 'turn': {
        let delta: TokenUsage = { ...ZERO_USAGE };
        let isNewTurn = true;
        if (item.message_id !== undefined) {
          const prev = messageUsage.get(item.message_id);
          isNewTurn = prev === undefined;
          if (item.usage) {
            const p = prev ?? ZERO_USAGE;
            delta = {
              input_tokens: Math.max(0, item.usage.input_tokens - p.input_tokens),
              output_tokens: Math.max(0, item.usage.output_tokens - p.output_tokens),
              cached_tokens: Math.max(0, item.usage.cached_tokens - p.cached_tokens),
            };
            messageUsage.set(item.message_id, {
              input_tokens: Math.max(p.input_tokens, item.usage.input_tokens),
              output_tokens: Math.max(p.output_tokens, item.usage.output_tokens),
              cached_tokens: Math.max(p.cached_tokens, item.usage.cached_tokens),
            });
          } else if (!prev) {
            messageUsage.set(item.message_id, { ...ZERO_USAGE });
          }
        } else if (item.usage) {
          delta = item.usage;
        }
        if (isNewTurn) turns++;
        usage = addUsage(usage, delta);
        const stepUsd = estimateUsd(delta, driver.pricing);
        runningUsd += stepUsd;
        if (item.text) lastTurnText = item.text;
        const step = emitStep('model_turn', item.text, {
          tokens_in: delta.input_tokens + delta.cached_tokens,
          tokens_out: delta.output_tokens,
          cost_usd: stepUsd,
        });
        appendInjection(injection, detectInjection(item.text, 'model_output', `step:${step.seq}`));
        checkCaps();
        return;
      }
      case 'tool_call': {
        toolCalls++;
        toolNames.set(item.id, item.name);
        const tcl = toolCallId(item.id);
        let content: string;
        try {
          content = JSON.stringify({ name: item.name, input: item.input });
        } catch {
          content = JSON.stringify({ name: item.name });
        }
        emitStep('tool_call', content, { tool_name: item.name, tool_call_id: tcl });
        const inp = item.input as Record<string, unknown> | null;
        if (/^(bash|shell)$/i.test(item.name) && inp && typeof inp.command === 'string') {
          commands.push({ command: clip(redactor.text(inp.command), 2000), tool_call_id: tcl });
        }
        return;
      }
      case 'tool_result': {
        const step = emitStep('tool_result', item.text, {
          tool_call_id: toolCallId(item.id),
          is_error: item.is_error,
          ...(toolNames.has(item.id) ? { tool_name: toolNames.get(item.id) } : {}),
        });
        appendInjection(injection, detectInjection(item.text, 'tool_result', `step:${step.seq}`));
        return;
      }
      case 'result': {
        resultItem = item;
        if (item.session_id) sessionId = item.session_id;
        if (typeof item.usd === 'number' && Number.isFinite(item.usd) && item.usd > runningUsd)
          runningUsd = item.usd;
        checkCaps();
        return;
      }
      case 'error': {
        emitError(item.code, item.message, item.raw);
        return;
      }
    }
  };

  let resolveResult!: (r: RunResult) => void;
  let resolveMeta!: (m: RunMeta) => void;
  const result = new Promise<RunResult>((r) => (resolveResult = r));
  const meta = new Promise<RunMeta>((r) => (resolveMeta = r));

  const main = async () => {
    let homeToRemove: string | null = null;
    let exitCode = -1;
    let spawnError: string | undefined;
    let gitEnv: Record<string, string> = {};
    try {
      let prepared: PreparedRun;
      try {
        prepared = await driver.prepare(input, opts);
      } catch (e) {
        throw isAdapterError(e) ? e : new AdapterError('preflight_failed', (e as Error).message);
      }
      fingerprint = prepared.fingerprint;
      model = prepared.model;
      if (prepared.session_id) sessionId = prepared.session_id;
      redactor = new Redactor([
        ...Object.values(opts.credentialEnv ?? {}),
        ...Object.values(prepared.credentialEnv),
      ]);

      let home = opts.homeDir;
      if (home) mkdirSync(home, { recursive: true });
      else {
        home = mkdtempSync(join(tmpdir(), `fw-${input.run_id}-home-`));
        homeToRemove = home;
      }
      const env = buildSandboxEnv({
        home,
        credentialEnv: prepared.credentialEnv,
        sandbox: input.sandbox,
        ...(prepared.extraEnv ? { extra: prepared.extraEnv } : {}),
      });
      gitEnv = buildSandboxEnv({ home });

      emitStep('prompt', prepared.prompt);
      if (killedReason) throw new AdapterError('internal', 'killed before spawn');

      const parse = driver.createParser();
      proc = spawnGroup({
        command: prepared.command,
        args: prepared.args,
        cwd: input.workspace.path,
        env,
        ...(prepared.stdin !== undefined ? { stdin: prepared.stdin } : {}),
        onStdout: (l) => {
          if (l.kind === 'too_long') {
            emitError('line_too_long', `stdout line of ${l.byte_length} bytes dropped`);
            return;
          }
          if (l.text.trim() === '') return;
          let items: VendorItem[];
          try {
            items = parse(l.text);
          } catch (e) {
            items = [
              {
                kind: 'error',
                code: 'internal',
                message: `parser threw: ${(e as Error).message}`,
                raw: l.text,
              },
            ];
          }
          for (const it of items) {
            try {
              handle(it);
            } catch (e) {
              emitError('internal', `handler threw: ${(e as Error).message}`);
            }
          }
        },
        onStderr: (line) => {
          stderrTail.push(clip(redactor.text(line), 500));
          if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        },
      });
      if (proc.pgid !== null) emit({ type: 'process', phase: 'spawned', pgid: proc.pgid, at: iso() });
      const timer = setTimeout(
        () => breach('wall_clock', wallClockMs(input), wallClockMs(input)),
        wallClockMs(input),
      );
      const exit = await proc.exited;
      clearTimeout(timer);
      exitCode = exit.exit_code;
      spawnError = exit.spawn_error;
      if (spawnError) emitError('spawn_failed', spawnError);
      emit({
        type: 'process',
        phase: 'exited',
        ...(proc.pgid !== null ? { pgid: proc.pgid } : {}),
        exit_code: exit.exit_code,
        ...(exit.signal ? { signal: exit.signal } : {}),
        at: iso(),
      });
    } catch (e) {
      if (isAdapterError(e) && !(killedReason && e.code === 'internal')) {
        refusal = e;
        emitError(e.code, e.message);
      } else if (!isAdapterError(e)) {
        emitError('internal', (e as Error).message);
        spawnError = (e as Error).message;
      }
      if (proc) await proc.kill(graceMs);
    }

    // Final accounting.
    let artifacts: ArtifactPointer[] = [];
    const sources: Array<'git' | 'claimed'> = [];
    let files: string[] | undefined;
    let diffStats: RunResult['diff_stats'];
    if (!refusal) {
      const changes = await collectGitChanges(
        input.workspace.path,
        input.workspace.base_commit,
        gitEnv,
      ).catch(() => null);
      if (changes) {
        files = changes.files_changed;
        diffStats = {
          files_changed: changes.files_changed.length,
          lines_added: changes.lines_added,
          lines_removed: changes.lines_removed,
        };
        if (changes.head && changes.head !== input.workspace.base_commit) {
          artifacts.push({
            kind: 'commit',
            ref: input.workspace.branch ? `${input.workspace.branch}@${changes.head}` : changes.head,
            sha: changes.head,
          });
          sources.push('git');
        }
      }
      for (const a of sanitizeArtifacts(resultItem?.artifacts)) {
        if (artifacts.some((x) => x.kind === a.kind && x.ref === a.ref)) continue;
        artifacts.push(a);
        sources.push('claimed');
      }
    }
    artifacts = artifacts.slice(0, 50);

    const report = sanitizeReport(resultItem?.report);
    appendInjection(injection, report.injection_suspected ?? []);
    const finalUsage = resultItem?.usage ?? usage;
    const cost = costRecord(finalUsage, resultItem?.usd, driver.pricing);

    let status: RunStatus;
    let failure: FailureClass | null = null;
    const vendorBudgetStop = resultItem && /max_budget|max_turns|budget/i.test(resultItem.subtype ?? '');
    if (refusal) {
      status = 'refused';
      failure = 'adapter';
    } else if (capBreach) {
      status = (capBreach as { cap: CapName }).cap === 'wall_clock' ? 'timeout' : 'budget_exceeded';
      failure = status === 'timeout' ? 'timeout' : 'budget';
    } else if (killedReason) {
      status = 'stopped';
      failure = 'killed';
    } else if (spawnError) {
      status = 'failed';
      failure = 'adapter';
    } else if (vendorBudgetStop) {
      status = 'budget_exceeded';
      failure = 'budget';
    } else if (exitCode !== 0) {
      status = 'failed';
      failure = 'nonzero_exit';
    } else if (!resultItem) {
      status = 'failed';
      failure = 'schema';
    } else if (!resultItem.ok) {
      status = 'failed';
      failure = 'adapter';
    } else if (artifacts.length === 0) {
      status = 'failed';
      failure = 'no_artifact';
    } else {
      status = 'completed';
    }

    let summary = report.summary ?? resultItem?.summary ?? lastTurnText;
    if (status !== 'completed' && stderrTail.length)
      summary = `${summary}\n[stderr] ${stderrTail.slice(-5).join('\n')}`;
    if (refusal) summary = `refused: ${refusal.message}`;

    const runResult: RunResult = {
      schema_version: '1',
      run_id: input.run_id,
      work_order_id: input.work_order.id,
      adapter: {
        vendor: driver.vendor,
        name: driver.name,
        version: fingerprint?.version ?? 'unknown',
        model: model || 'unknown',
      },
      session_id: sessionId || `none_${input.run_id}`,
      status,
      exit_code: refusal ? -1 : exitCode,
      started_at: startedAt,
      ended_at: iso(),
      cost: {
        input_tokens: cost.input_tokens,
        output_tokens: cost.output_tokens,
        cached_tokens: cost.cached_tokens,
        usd: cost.usd,
      },
      turns,
      tool_call_count: toolCalls,
      artifacts,
      summary: clip(summary.trim() || status, 2000),
    };
    if (report.claims) runResult.claims = report.claims;
    if (diffStats) runResult.diff_stats = diffStats;
    if (report.stop_requests) runResult.stop_requests = report.stop_requests;
    if (files) runResult.files_changed = files;
    if (report.tests_added) runResult.tests_added = report.tests_added;
    if (report.tests_modified) runResult.tests_modified = report.tests_modified;
    if (commands.length) runResult.commands_run = commands.slice(0, 200);
    if (report.followups) runResult.followups = report.followups;
    if (injection.length) runResult.injection_suspected = injection;

    const runMeta: RunMeta = {
      fingerprint,
      cost,
      failure_class: failure,
      cap_breach: capBreach,
      killed_reason: killedReason,
      pgid: (proc as GroupProcess | null)?.pgid ?? null,
      error_count: errorCount,
      artifact_sources: sources,
      stderr_tail: stderrTail,
    };

    if (homeToRemove) {
      try {
        rmSync(homeToRemove, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    resolveResult(redactor.deep(runResult));
    resolveMeta(redactor.deep(runMeta));
    queue.close();
  };

  void main().catch((e) => {
    // Last resort: main() handles its own errors, so this only fires on a bug.
    emitError('internal', (e as Error).message);
    void proc?.kill(graceMs);
    resolveResult(
      redactor.deep({
        schema_version: '1',
        run_id: input.run_id,
        work_order_id: input.work_order.id,
        adapter: { vendor: driver.vendor, name: driver.name, version: 'unknown', model: 'unknown' },
        session_id: sessionId || `none_${input.run_id}`,
        status: 'failed',
        exit_code: -1,
        cost: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, usd: runningUsd },
        artifacts: [],
        summary: 'adapter internal error',
      }),
    );
    resolveMeta({
      fingerprint,
      cost: { ...usage, usd: runningUsd, estimated: true },
      failure_class: 'adapter',
      cap_breach: capBreach,
      killed_reason: killedReason,
      pgid: proc?.pgid ?? null,
      error_count: errorCount,
      artifact_sources: [],
      stderr_tail: [],
    });
    queue.close();
  });

  return {
    run_id: input.run_id,
    events: queue,
    result,
    meta,
    pgid: () => proc?.pgid ?? null,
    kill: async (reason: string) => {
      if (!killedReason && !capBreach) {
        killedReason = clip(reason, 300);
        emit({ type: 'killed', reason: killedReason, at: iso() });
      }
      if (proc) await proc.kill(graceMs);
      await result;
    },
  };
}
