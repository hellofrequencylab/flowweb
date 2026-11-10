/**
 * The one place the web UI talks to fwd (LOCAL-API-V1.md). It unwraps the
 * envelope, keeps `as_of` as `data_as_of`, and maps schema rows (wire.ts) to
 * the view models the screens use (types.ts). Screens never see wire shapes,
 * so when FW-C-018 generates the typed client only this file changes.
 */
import { accessToken, chosenAccount, HOSTED, signOutHosted, UNREACHABLE } from '../hosted/auth';
import { parseUnifiedDiff, sha256Hex } from './diff';
import type * as V from './types';
import type * as W from './wire';

export const API_BASE = '/v1';
export const EVENTS_URL = `${API_BASE}/events/stream`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** fwd's error details, when it sent any (for example the reasons a config was refused). */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** fwd could not be reached at all (network error, daemon down, proxy 502). */
export class UnreachableError extends Error {
  constructor() {
    super(UNREACHABLE);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

async function raw(
  method: string,
  path: string,
  body?: unknown,
  accept = 'application/json',
): Promise<Response> {
  let res: Response;
  const headers: Record<string, string> =
    body === undefined ? { Accept: accept } : { Accept: accept, 'Content-Type': 'application/json' };
  if (HOSTED) {
    // The live mirror has no cookie session; it takes the signed-in owner's token.
    const token = await accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // FW-C-088: the business chosen in Settings, when the login belongs to more than one.
    const account = chosenAccount();
    if (account) headers['x-fw-account'] = account;
  }
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new UnreachableError();
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new UnreachableError();
  if (res.status === 501) {
    // C0 fwd answers 501 not_implemented for writes that a later row adds.
    let detail = '';
    try {
      const j = (await res.clone().json()) as W.WireError;
      detail = j.error?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new ApiError(
      501,
      'not_implemented',
      `fwd does not support this yet${detail ? ` (${detail})` : ''}`,
    );
  }
  if (res.status === 401) {
    for (const fn of unauthorizedListeners) fn();
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText || 'Request failed';
    let details: unknown;
    try {
      const j = (await res.json()) as W.WireError;
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
      details = j.error?.details;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, message, details);
  }
  return res;
}

async function get<T>(path: string): Promise<W.Envelope<T>> {
  return (await raw('GET', path)).json() as Promise<W.Envelope<T>>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await raw('POST', path, body);
  if (res.status === 204) return undefined as T;
  const j = (await res.json()) as T | W.Envelope<T>;
  return j && typeof j === 'object' && 'data' in j && 'as_of' in j ? (j as W.Envelope<T>).data : (j as T);
}

const enc = encodeURIComponent;

/**
 * An Owner write. Local fwd answers it at once. The live site queues it for the Owner's machine
 * (FW-C-062) and answers a request id: then this waits for the relay's answer, saying so through
 * `onQueued`, and gives up after `minutes` (the request stays queued for a day).
 */
export async function ownerWrite<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  onQueued?: () => void,
  minutes = 5,
): Promise<T> {
  const res = await raw(method, path, body);
  if (res.status === 204) return undefined as T;
  const j = (await res.json()) as unknown;
  const r = (j && typeof j === 'object' && 'data' in j ? (j as { data: unknown }).data : j) as
    | T
    | { request_id: string; status: string };
  if (!r || typeof r !== 'object' || !('request_id' in r) || res.status !== 202) return r as T;
  onQueued?.();
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const e = await get<{ status: string; result: T | null; error: string | null }>(
      `/hosted/requests/${enc(r.request_id)}`,
    );
    if (e.data.status === 'done') return e.data.result as T;
    if (e.data.status === 'failed')
      throw new Error(e.data.error ?? 'Your machine could not make that change.');
    if (Date.now() > until)
      throw new Error(
        'Your Mac has not answered yet. The change stays queued for a day and applies when FlowWeb there is running.',
      );
  }
}
const qs = (q: Record<string, string | number | undefined | null>) => {
  const p = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  return p.length ? `?${new URLSearchParams(p).toString()}` : '';
};

/* ---------------- mappers ---------------- */

export function mapStatus(s: W.WStatus, asOf: string): V.Status {
  const k = s.kill;
  let state: V.KillState = 'ready';
  if (k.engaged) {
    const pending =
      k.runs_to_halt !== undefined && k.runs_halted !== undefined && k.runs_halted < k.runs_to_halt;
    state = pending ? 'stopping' : 'stopped';
  }
  return {
    data_as_of: asOf,
    version: s.version,
    kill_switch: {
      state,
      engaged_at: k.engaged_at ?? undefined,
      runs_halted: k.runs_halted,
      runs_to_halt: k.runs_to_halt,
      keys_revoked: k.keys_revoked,
    },
    cards_open: s.open_cards,
    running_runs: s.running_runs,
    oldest_card_created_at: s.oldest_open_card_at ?? undefined,
    spend_today: s.spend
      ? {
          usd: s.spend.today_usd,
          cap_usd: s.spend.daily_cap_usd,
          vendors_reporting: s.spend.vendors_reporting,
          vendors_configured: s.spend.vendors_configured,
          estimated: Boolean(s.spend.estimated),
        }
      : undefined,
    breaker: s.breaker ? { tripped: s.breaker.tripped, reason: s.breaker.reason ?? undefined } : undefined,
    paused_by_budget: s.paused_by_budget,
    sandbox_egress: s.sandbox_level,
    integrity: {
      ok: s.chain.ok,
      verified_up_to_seq: s.chain.head_seq,
      checked_at: s.chain.verified_at,
      failed_at_seq: s.chain.failed_seq,
    },
    last_seq: s.chain.head_seq,
    sender: s.sender,
  };
}

function mapRowSummary(r: W.WLedgerRow): V.RowSummary {
  return {
    ledger_row_id: r.id,
    row_id: r.code,
    title: r.title,
    status: r.status,
    blocked_reason: r.blocked_reason,
    priority: r.priority,
    lane: r.lane,
    depends_on: r.depends_on ?? [],
    last_probe: {
      status: r.last_probe_status,
      at: r.last_probe_at,
      target_kind:
        r.last_probe_target ?? (r.status === 'done' || r.status === 'watching' ? 'merged' : undefined),
    },
    last_run_id: r.last_run_id,
    evidence_bundle_id: r.evidence_bundle_id,
    updated_at: r.updated_at,
  };
}

/** Run status words agreed with the Core thread (LOCAL-API-V1.md). */
export function mapRunStatus(r: W.WRun): V.RunStatus {
  switch (r.status) {
    case 'validating':
      return 'checking';
    case 'killed':
      return 'halted';
    case 'succeeded':
      return r.artifact_verified || r.artifacts?.some((a) => a.verified_by_kernel)
        ? 'artifact_verified'
        : 'finished_unchecked';
    case 'failed':
      return r.failure_class === 'no_artifact' || r.failure_class === 'claim_mismatch'
        ? 'claimed_unverified'
        : 'failed';
    default:
      return r.status;
  }
}

function mapRun(r: W.WRun): V.RunSummary {
  return {
    run_id: r.id,
    row_id: r.row_code,
    role: r.agent_role,
    vendor: r.adapter_vendor,
    adapter: r.adapter_name,
    status: mapRunStatus(r),
    started_at: r.started_at ?? undefined,
    ended_at: r.ended_at ?? undefined,
    heartbeat_at: r.last_heartbeat_at,
    cost_usd: r.cost_usd,
    cost_estimated: Boolean(r.cost_estimated),
    sandbox: r.sandbox_level,
  };
}

function cardState(c: W.WCardDetail | W.WCard): V.CardState {
  const d = c as W.WCardDetail;
  if (
    c.status === 'open' &&
    d.approval &&
    d.pr &&
    d.approval.head_sha &&
    d.pr.current_head_sha &&
    d.pr.current_head_sha !== d.approval.head_sha
  )
    return 'stale';
  if (c.status === 'answered') {
    const decision = (c.answer?.decision as string | undefined) ?? d.approval?.status;
    if (decision === 'approved') return 'approved';
    if (decision === 'denied') return 'denied';
    return 'answered';
  }
  return c.status;
}

function mapCardSummary(c: W.WCard): V.CardSummary {
  return {
    id: c.id,
    variant: c.variant,
    title: c.title,
    project_name: c.project_name,
    row_id: c.row_code ?? undefined,
    created_at: c.created_at,
    deadline_at: c.deadline_at ?? undefined,
    urgency: c.urgency,
    state: cardState(c),
  };
}

const URGENCY_RANK: Record<V.Urgency, number> = { now: 0, today: 1, this_week: 2, whenever: 3 };
/** Sorted by deadline, then urgency, then age (oldest first). */
export function sortQueue(cards: V.CardSummary[]): V.CardSummary[] {
  return [...cards].sort((a, b) => {
    const da = a.deadline_at ? Date.parse(a.deadline_at) : Infinity;
    const db = b.deadline_at ? Date.parse(b.deadline_at) : Infinity;
    if (da !== db) return da - db;
    if (URGENCY_RANK[a.urgency] !== URGENCY_RANK[b.urgency])
      return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
}

/** The parts of decision-card.json the UI reads. fwd validates the body; every field may be absent. */
interface CardBody {
  headline?: string;
  payload_preview?: Partial<V.ApproveCard['payload_preview']>;
  risk?: V.ApproveCard['risk'];
  options?: V.ChooseCard['options'];
  recommended_option?: V.ChooseCard['recommended_option'];
  recommendation_reason?: V.ChooseCard['recommendation_reason'];
  question?: string;
  answer_type?: V.AnswerCard['answer_type'];
  constraints?: V.AnswerCard['constraints'];
  suggested_answer?: V.AnswerCard['suggested_answer'];
  basis_gap?: V.AnswerCard['basis_gap'];
  artifact?: V.ReviewCard['artifact'];
  verifier_summary?: V.ReviewCard['verifier_summary'];
  blocker?: V.UnblockCard['blocker'];
  suggested_actions?: V.UnblockCard['suggested_actions'];
}

function mapCard(c: W.WCardDetail): V.DecisionCard {
  const b = c.body as CardBody; // decision-card.json, validated by fwd
  const resolution =
    c.answered_at || c.status === 'expired'
      ? {
          at: c.answered_at ?? c.deadline_at ?? c.created_at,
          by: (c.answered_by ? 'owner' : 'system') as 'owner' | 'system',
          decision:
            c.status === 'expired'
              ? c.default_on_timeout
              : String(c.answer?.decision ?? c.answer?.option_id ?? c.answer?.value ?? 'answered'),
          reason: (c.answer?.reason_code as string | undefined) ?? undefined,
        }
      : undefined;
  const base = {
    id: c.id,
    state: cardState(c),
    title: c.title,
    ask: c.ask,
    urgency: c.urgency,
    autonomy_tier: c.policy?.tier ?? null,
    project_id: c.project_id,
    project_name: c.project_name,
    row_id: c.row_code ?? undefined,
    asked_by: c.asked_by,
    created_at: c.created_at,
    deadline_at: c.deadline_at ?? undefined,
    default_on_timeout: c.default_on_timeout,
    evidence_bundle_id: c.evidence_bundle_id ?? undefined,
    why: c.policy
      ? { rule_id: `${c.policy.rule_id} v${c.policy.rule_version}`, text: c.policy.reason }
      : null,
    resolution,
    snoozed_until: c.snoozed_until ?? undefined,
  };
  switch (c.variant) {
    case 'approve':
      return {
        ...base,
        variant: 'approve',
        approval_id: c.approval_id!,
        headline: b.headline ?? c.title,
        payload_preview: {
          format: b.payload_preview?.format ?? 'diff',
          excerpt: b.payload_preview?.excerpt,
          full_ref: b.payload_preview?.full_ref ?? '',
          // Empty when unknown: it then matches no evidence, so Approve stays locked.
          payload_hash: c.approval?.payload_hash ?? b.payload_preview?.payload_hash ?? '',
        },
        head_sha: c.approval?.head_sha ?? null,
        expires_at: c.approval?.expires_at,
        current_head_sha: c.pr?.current_head_sha,
        head_observed_at: c.pr?.head_observed_at,
        pr: c.pr ? { url: c.pr.url, number: c.pr.number } : undefined,
        replacement_card_id: c.superseded_by_card_id ?? undefined,
        risk: b.risk ?? { blast_radius: 'Not reported', reversible: false, scan_status: 'warn' },
        cost_usd: c.cost_usd,
        files: c.files,
        merge_slot: c.merge_slot,
      };
    case 'choose':
      return {
        ...base,
        variant: 'choose',
        options: b.options ?? [],
        recommended_option: b.recommended_option ?? '',
        recommendation_reason: b.recommendation_reason ?? '',
      };
    case 'answer':
      return {
        ...base,
        variant: 'answer',
        question: b.question ?? c.ask,
        answer_type: b.answer_type ?? 'text',
        constraints: b.constraints,
        suggested_answer: b.suggested_answer,
        basis_gap: b.basis_gap,
      };
    case 'review':
      return {
        ...base,
        variant: 'review',
        artifact: b.artifact ?? { kind: 'report', ref: '' },
        verifier_summary: b.verifier_summary,
      };
    case 'unblock':
      return {
        ...base,
        variant: 'unblock',
        blocker: b.blocker ?? { kind: 'unknown', description: c.ask, since: c.created_at },
        suggested_actions: b.suggested_actions ?? [],
      };
  }
}

function mapEvent(e: W.WEvent): V.EventItem {
  const p = e.payload ?? {};
  const summary = (p.summary as string) ?? (p.message as string) ?? (p.reason as string) ?? '';
  return { seq: e.seq, ts: e.ts, type: e.type, actor: `${e.actor_kind}:${e.actor_id}`, summary };
}

function stepLabel(s: W.WRunStep): string {
  if (s.label) return s.label;
  const words: Record<W.WRunStep['kind'], string> = {
    prompt: 'Prompt',
    model_turn: 'Model turn',
    tool_call: 'Tool call',
    tool_result: 'Tool result',
    checkpoint: 'Checkpoint',
    stop_request: 'Stop request',
    escalation: 'Escalation',
    human_input: 'Owner input',
  };
  return words[s.kind];
}

function dayStart(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/* ---------------- API ---------------- */

export const api = {
  /** 401 means not paired. */
  async session(): Promise<V.Session> {
    const e = await get<W.WSession>('/session');
    return { paired_at: e.data.paired_at, device_label: e.data.device_label };
  },
  pair: (code: string) => post<unknown>('/pair', { code }),
  signOut: () => (HOSTED ? signOutHosted() : raw('DELETE', '/session').then(() => undefined)),

  /** Hosted mirror only: machines whose relay pushes to this site. */
  async machines(): Promise<V.MachineList> {
    const e = await get<W.WMachine[]>('/hosted/machines');
    return { data_as_of: e.as_of, machines: e.data };
  },
  /** Hosted mirror only: a new relay token, shown once. */
  async addMachine(label: string): Promise<{ token: string }> {
    const r = await post<{ token?: string } | { data?: { token?: string } }>('/hosted/machines', { label });
    // Older deploys answered `{ data: { token } }` without an as_of, which `post` does not unwrap.
    const token = (r && 'token' in r ? r.token : (r as { data?: { token?: string } })?.data?.token) ?? '';
    if (!token.startsWith('fwr_')) throw new Error('The site did not return a relay token. Try again.');
    return { token };
  },
  revokeMachine: (id: string) => post<unknown>(`/hosted/machines/${enc(id)}/revoke`, {}),

  async status(): Promise<V.Status> {
    const e = await get<W.WStatus>('/status');
    return mapStatus(e.data, e.as_of);
  },

  /**
   * Console. Uses the daily digest when one exists and passed its own check;
   * the live counts always come from current queries so the screen can fall
   * back to them, labelled, when the digest is missing or failed.
   */
  async dawn(): Promise<V.DawnLog> {
    const reports = await get<W.WStatusReport[]>(`/status-reports${qs({ kind: 'daily', limit: 1 })}`);
    const r = reports.data[0];
    const since = r?.period_from ?? new Date(dayStart().getTime() - 86_400_000).toISOString();
    const [done, watching, runs] = await Promise.all([
      get<W.WLedgerRow[]>(`/ledger/rows${qs({ status: 'done', limit: 200 })}`),
      get<W.WLedgerRow[]>(`/ledger/rows${qs({ status: 'watching', limit: 200 })}`),
      get<W.WRun[]>(`/runs${qs({ limit: 200 })}`),
    ]);
    const after = (iso: string | null | undefined) => Boolean(iso && iso >= since);
    const landed = (rows: W.WLedgerRow[]) =>
      rows
        .filter((x) => after(x.closed_at ?? x.updated_at))
        .map((x) => ({
          row_id: x.code,
          ledger_row_id: x.id,
          title: x.title,
          merged_sha: x.merged_sha ?? '',
          probe_status: x.last_probe_status,
          probe_at: x.last_probe_at ?? undefined,
        }));
    const recent = runs.data.filter((x) => after(x.ended_at));
    const asOf = [reports.as_of, done.as_of, watching.as_of, runs.as_of].sort()[0]; // the oldest read
    return {
      data_as_of: asOf,
      digest: r
        ? {
            id: r.id,
            produced_at: r.created_at,
            since: r.period_from,
            // fwd stores a daily report only after it passed its recompute check (a failing one is
            // recorded as digest.rejected instead), and status-report.json has no self_check field.
            self_check_ok: r.body.self_check?.passed ?? true,
            failed_query_ids: r.body.self_check?.failed_query_ids ?? [],
            headline: r.body.headline,
          }
        : null,
      since,
      rows_done: landed(done.data),
      rows_watching: landed(watching.data),
      runs: {
        succeeded: recent.filter((x) => x.status === 'succeeded').length,
        failed: recent.filter((x) => x.status === 'failed' || x.status === 'timed_out').length,
        halted: recent.filter((x) => x.status === 'killed').length,
        total: recent.length,
      },
    };
  },

  async cards(): Promise<V.CardList> {
    const e = await get<W.WCard[]>(`/decision-cards${qs({ status: 'open', limit: 200 })}`);
    return { data_as_of: e.as_of, cards: sortQueue(e.data.map(mapCardSummary)) };
  },
  async card(id: string): Promise<V.CardDetail> {
    const e = await get<W.WCardDetail>(`/decision-cards/${enc(id)}`);
    return { data_as_of: e.as_of, card: mapCard(e.data) };
  },

  /** Approve, deny or request changes. Bound to the payload hash and head the Owner saw. */
  respondApproval: (
    approvalId: string,
    r: {
      decision: 'approved' | 'denied' | 'changes_requested';
      payload_hash: string;
      head_sha: string | null;
      reason_code?: V.ReasonCode;
      comment?: string;
    },
  ) =>
    post<unknown>(`/approvals/${enc(approvalId)}/respond`, {
      approval_id: approvalId,
      decision: r.decision,
      payload_hash: r.payload_hash,
      head_sha: r.head_sha ?? undefined,
      method: 'deck_click',
      reason_code: r.reason_code,
      comment: r.comment,
      responded_at: new Date().toISOString(),
    }),
  answer: (cardId: string, a: { option_id: string } | { value: string | number | boolean | null }) =>
    post<unknown>(`/decision-cards/${enc(cardId)}/answer`, a),
  snooze: (cardId: string, until: string) =>
    post<unknown>(`/decision-cards/${enc(cardId)}/snooze`, { until }),

  async evidence(id: string): Promise<V.Evidence> {
    const e = await get<W.WEvidenceBundle>(`/evidence-bundles/${enc(id)}`);
    const x = e.data;
    const b = x.body;
    const v = x.view ?? ({} as Partial<W.WEvidenceBundle['view']>);
    return {
      data_as_of: e.as_of,
      bundle_id: x.id,
      bundle_hash: x.bundle_hash,
      payload_hash: b.intent_payload.payload_hash,
      diff_hash: v.diff?.hash,
      subject: { kind: x.subject_kind, ref: x.subject_ref, sha: x.subject_sha },
      captured_by: x.captured_by,
      scan_red: x.scan_red === 1,
      checks: b.automated_evidence,
      independent_check: b.independent_check
        ? {
            vendor: b.independent_check.vendor,
            verdict: b.independent_check.verdict,
            summary: v.verifier_summary ?? undefined,
            findings_ref: b.independent_check.findings_ref,
            same_vendor_review: Boolean(b.independent_check.same_vendor_review),
          }
        : undefined,
      blast_radius: { affected: [], ...b.blast_radius },
      files: v.diff?.files ?? [],
      tests_removed_or_skipped: v.tests_removed_or_skipped ?? [],
      probe: v.probe
        ? { exit_code: v.probe.exit_code, tail: v.probe.output_tail, duration_ms: v.probe.duration_ms }
        : null,
      cost: {
        usd: b.cost_estimate_usd,
        input_tokens: v.tokens?.input,
        output_tokens: v.tokens?.output,
        estimated: v.tokens?.estimated ?? b.cost_estimate_usd !== undefined,
      },
      sandbox: v.sandbox ? { level: v.sandbox.level, controls: v.sandbox.controls ?? [] } : undefined,
      adapter: v.adapter ? { name: v.adapter.name, version: v.adapter.version } : undefined,
      screenshots: b.visual_evidence ?? [],
      not_verified: b.not_verified ?? [],
    };
  },
  /** The literal diff bytes; the browser hashes them so the UI can show they match. */
  async evidenceDiff(id: string): Promise<V.ParsedDiff> {
    const res = await raw('GET', `/evidence-bundles/${enc(id)}/diff`, undefined, 'text/x-diff');
    const text = await res.text();
    return {
      data_as_of: new Date().toISOString(),
      sha256: await sha256Hex(text),
      files: parseUnifiedDiff(text),
    };
  },

  async projects(): Promise<V.ProjectList> {
    const e = await get<W.WProject[]>('/projects');
    return {
      data_as_of: e.as_of,
      projects: e.data.map((p) => ({
        id: p.id,
        name: p.name,
        repo: p.repo_url,
        status: p.status,
        brand: p.brand ?? null,
        category: p.category ?? null,
        brief: p.brief
          ? {
              what: p.brief.what,
              who: p.brief.who,
              voice: p.brief.voice,
              never: p.brief.never,
              done: p.brief.done,
            }
          : null,
        rows_open: p.rows_open,
        rows_in_progress: p.rows_in_progress,
        rows_waiting_on_owner: p.rows_waiting_on_owner,
        last_run_at: p.last_run_at,
      })),
    };
  },
  async rows(f: { status?: string } = {}): Promise<V.RowList> {
    const e = await get<W.WLedgerRow[]>(`/ledger/rows${qs({ status: f.status, limit: 200 })}`);
    return { data_as_of: e.as_of, rows: e.data.map(mapRowSummary) };
  },
  async row(id: string): Promise<V.RowDetail> {
    const e = await get<W.WLedgerRowDetail>(`/ledger/rows/${enc(id)}`);
    const r = e.data;
    return {
      data_as_of: e.as_of,
      row: {
        ...mapRowSummary(r),
        description: r.description,
        size: r.size,
        probe: {
          kind: r.probe_kind,
          measures: r.probe_measures,
          command: r.probe_spec.argv ? r.probe_spec.argv.join(' ') : JSON.stringify(r.probe_spec),
          runs_against: r.probe_runs_against,
          content_hash: r.probe_hash,
        },
        last_probe_detail: {
          status: r.last_probe_status,
          sha: r.last_probe_sha,
          at: r.last_probe_at,
          output_ref: r.last_probe_output_ref,
        },
        premise: r.premise_retested_at
          ? {
              retested_at: r.premise_retested_at,
              still_valid: r.premise_valid === null ? null : r.premise_valid === 1,
            }
          : undefined,
        acceptance: r.acceptance,
        merged_sha: r.merged_sha,
      },
      evidence: (r.evidence ?? []).map((x) => ({
        id: x.id,
        created_at: x.created_at,
        scan_red: x.scan_red === 1,
      })),
      runs: (r.runs ?? []).map(mapRun),
    };
  },
  async events(
    f: { run_id?: string; type?: string; project_id?: string; limit?: number } = {},
  ): Promise<V.EventList> {
    const e = await get<W.WEvent[]>(`/events${qs({ ...f, limit: f.limit ?? 50 })}`);
    return { data_as_of: e.as_of, events: e.data.map(mapEvent) };
  },

  /** FW-C-075: flow cycles and daily digests, which fwd keeps as status reports, not runs. */
  async flowRuns(): Promise<V.FlowRunList> {
    const [cycles, digests] = await Promise.all([
      get<W.WFlowCycleReport[]>(`/status-reports${qs({ kind: 'run', limit: 200 })}`),
      get<W.WStatusReport[]>(`/status-reports${qs({ kind: 'daily', limit: 30 })}`),
    ]);
    const flowRuns: V.FlowRun[] = [
      ...cycles.data.map((r): V.FlowRun => {
        const b = r.body ?? {};
        return {
          id: r.id,
          kind: 'cycle',
          flow: b.flow ?? 'flow',
          outcome: b.outcome ?? 'unknown',
          drafts: b.drafts ?? 0,
          found: (b.hunts ?? []).reduce((n, h) => n + (h.found ?? 0), 0),
          engine: b.adapter,
          reason: b.reason,
          started_at: r.period_from,
          ended_at: r.period_to,
        };
      }),
      ...digests.data.map(
        (r): V.FlowRun => ({
          id: r.id,
          kind: 'digest',
          flow: 'digest',
          outcome: 'published',
          drafts: 0,
          found: 0,
          started_at: r.created_at,
          ended_at: r.created_at,
        }),
      ),
    ].sort((a, b) => b.started_at.localeCompare(a.started_at));
    return { data_as_of: [cycles.as_of, digests.as_of].sort()[0], flow_runs: flowRuns };
  },

  async runs(f: { status?: string; row_id?: string } = {}): Promise<V.RunList> {
    const e = await get<W.WRun[]>(`/runs${qs({ status: f.status, row_id: f.row_id, limit: 200 })}`);
    return { data_as_of: e.as_of, runs: e.data.map(mapRun) };
  },
  async run(id: string): Promise<V.RunDetail> {
    const e = await get<W.WRun>(`/runs/${enc(id)}`);
    const r = e.data;
    const arts = r.artifacts ?? [];
    return {
      data_as_of: e.as_of,
      run: {
        ...mapRun(r),
        exit_code: r.exit_code,
        failure_class: r.failure_class,
        input_tokens: r.tokens_in,
        output_tokens: r.tokens_out,
        turns: r.turns,
        tool_version: r.adapter_version,
        model: r.model,
        branch: r.branch,
        summary: r.result?.summary,
      },
      artifacts_verified: arts
        .filter((a) => a.verified_by_kernel)
        .map((a) => ({ kind: a.kind, ref: a.ref, sha: a.sha, verified_at: a.verified_at })),
      artifacts_claimed: [
        ...arts
          .filter((a) => !a.verified_by_kernel)
          .map((a) => ({
            id: `artifact:${a.kind}:${a.ref}`,
            kind: a.kind,
            claim: `${a.kind} ${a.ref}`,
            ref: a.ref,
          })),
        ...(r.result?.claims ?? []).map((c, i) => ({
          id: `claim:${i}`,
          claim: c.claim,
          ref: c.evidence_ref,
        })),
      ],
      verifier: r.verifier,
    };
  },
  async runSteps(id: string): Promise<V.RunSteps> {
    const e = await get<W.WRunStep[]>(`/runs/${enc(id)}/steps`);
    return {
      data_as_of: e.as_of,
      steps: e.data.map((s) => ({
        id: s.id,
        seq: s.seq,
        kind: s.kind,
        label: stepLabel(s),
        at: s.started_at,
        ended_at: s.ended_at,
        excerpt: s.excerpt,
        blocked_by_policy: s.denied_by_policy,
        external_text: s.untrusted ?? s.kind === 'tool_result',
        cost_usd: s.cost_usd,
      })),
    };
  },

  async spend(): Promise<V.Spend> {
    const today = dayStart();
    const days = Array.from({ length: 7 }, (_, i) => new Date(today.getTime() - (6 - i) * 86_400_000));
    const iso = (d: Date) => d.toISOString();
    const now = new Date();
    const [status, byProject, byVendor, budgets, refused, hardStops, ...perDay] = await Promise.all([
      get<W.WStatus>('/status'),
      get<W.WSpend>(`/spend${qs({ group_by: 'project', from: iso(days[0]), to: iso(now) })}`),
      get<W.WSpend>(`/spend${qs({ group_by: 'vendor', from: iso(days[0]), to: iso(now) })}`),
      get<W.WBudget[]>('/budgets'),
      get<W.WEvent[]>(`/events${qs({ type: 'dispatch.refused_budget', limit: 50 })}`),
      get<W.WEvent[]>(`/events${qs({ type: 'budget.hard_stop', limit: 50 })}`),
      ...days.map((d, i) =>
        get<W.WSpend>(
          `/spend${qs({ group_by: 'project', from: iso(d), to: iso(i === 6 ? now : days[i + 1]) })}`,
        ),
      ),
    ]);
    const fleetDay = budgets.data.find((b) => b.scope_kind === 'fleet' && b.period === 'day');
    const st = mapStatus(status.data, status.as_of);
    return {
      data_as_of: [status.as_of, byProject.as_of, byVendor.as_of, budgets.as_of].sort()[0],
      today: st.spend_today,
      by_day: perDay.map((p, i) => ({ day: days[i].toISOString().slice(0, 10), usd: p.data.total_usd })),
      by_project: byProject.data.groups.map((g) => ({ key: g.key, label: g.label ?? g.key, usd: g.usd })),
      by_vendor: byVendor.data.groups.map((g) => ({ key: g.key, label: g.label ?? g.key, usd: g.usd })),
      refused: [...refused.data, ...hardStops.data]
        .sort((a, b) => b.seq - a.seq)
        .map((e) => ({ seq: e.seq, at: e.ts, type: e.type, summary: mapEvent(e).summary })),
      breaker: {
        tripped: Boolean(status.data.breaker?.tripped),
        reason: status.data.breaker?.reason,
        daily_usd: fleetDay?.breaker_daily_usd ?? null,
        velocity_usd_per_hour: fleetDay?.breaker_velocity_usd_per_h ?? null,
      },
    };
  },

  async flow(key: string): Promise<V.Flow> {
    const e = await get<Omit<V.Flow, 'data_as_of'>>(`/flows/${encodeURIComponent(key)}`);
    return { data_as_of: e.as_of, ...e.data };
  },

  async activationFlow(): Promise<V.ActivationFlow> {
    const e = await get<Omit<V.ActivationFlow, 'data_as_of'>>('/flows/neighborhood-activation');
    return { data_as_of: e.as_of, ...e.data };
  },

  /** FW-C-048: the paid ads flow, read only. */
  async adsFlow(): Promise<V.AdsFlow> {
    const e = await get<Omit<V.AdsFlow, 'data_as_of'>>('/flows/paid-ads');
    return { data_as_of: e.as_of, ...e.data };
  },

  /** FW-C-072: what's working, from the flow's latest weekly review. */
  async reviewSummary(key: string): Promise<V.ReviewSummary> {
    const e = await get<Omit<V.ReviewSummary, 'data_as_of'>>(
      `/flows/${encodeURIComponent(key)}/review/summary`,
    );
    return { data_as_of: e.as_of, ...e.data };
  },

  /** The drafts a flow's cycles wrote, newest first. fwd answers these to the CLI token only. */
  async flowDrafts(key: string): Promise<V.FlowDrafts> {
    const e = await get<V.FlowDraft[]>(`/supervisor/flows/${encodeURIComponent(key)}/drafts`);
    return { data_as_of: e.as_of, drafts: Array.isArray(e.data) ? e.data : [] };
  },

  /**
   * A draft change: edit, reject, approve, mark or an AI rewrite. On the live site it is queued and
   * applied on the Owner's machine by the relay, so this waits for that answer; `onQueued` says it is waiting.
   */
  draftChange<T = V.FlowDraft>(
    flow: string,
    id: string,
    action: 'edit' | 'reject' | 'rewrite' | 'mark' | 'approve',
    body: Record<string, string>,
    onQueued?: () => void,
  ): Promise<T> {
    return ownerWrite<T>(
      'POST',
      `/supervisor/flows/${enc(flow)}/drafts/${enc(id)}/${action}`,
      body,
      onQueued,
      action === 'rewrite' ? 15 : 5,
    );
  },

  /** FW-C-062: turn a flow on or off, or run it now. */
  flowControl: (flow: string, action: 'enable' | 'disable' | 'run', onQueued?: () => void) =>
    ownerWrite<unknown>('POST', `/supervisor/flows/${enc(flow)}/${action}`, {}, onQueued),
  /** FW-C-062: Draft or Copilot from anywhere; Autopilot needs the confirm hash fwd answers in a 409. */
  setDial: (flow: string, stop: V.SupervisorDial, confirm?: string, onQueued?: () => void) =>
    ownerWrite<unknown>(
      'POST',
      `/supervisor/flows/${enc(flow)}/dial`,
      confirm ? { stop, confirm } : { stop },
      onQueued,
    ),
  /** FW-C-063: when the flow runs each morning. */
  setSchedule: (flow: string, time: string, days: 'daily' | 'weekdays', onQueued?: () => void) =>
    ownerWrite<unknown>('POST', `/supervisor/flows/${enc(flow)}/schedule`, { time, days }, onQueued),
  /** FW-C-063: how many new people a day, and whether reply rates may move it within min..max. */
  setIntensity: (flow: string, i: V.FlowIntensitySetting, onQueued?: () => void) =>
    ownerWrite<unknown>(
      'POST',
      `/supervisor/flows/${enc(flow)}/intensity`,
      { per_day: i.per_day, auto: i.auto, min: i.min, max: i.max },
      onQueued,
    ),
  /** FW-C-087: a project's brief, all five answers. */
  setProjectBrief: (id: string, b: V.ProjectBriefAnswers, onQueued?: () => void) =>
    ownerWrite<unknown>('POST', `/projects/${enc(id)}/brief`, { ...b }, onQueued),
  /** FW-C-087: a project's brand and category; null clears one. */
  setProjectLabels: (
    id: string,
    l: { brand: string | null; category: string | null },
    onQueued?: () => void,
  ) => ownerWrite<unknown>('POST', `/projects/${enc(id)}/labels`, l, onQueued),
  /** FW-C-086: which AI account the flow's runs use. Only names one; the key stays on the machine. */
  setFlowAi: (flow: string, account: V.FlowAiAccount, onQueued?: () => void) =>
    ownerWrite<unknown>('POST', `/supervisor/flows/${enc(flow)}/ai`, { account }, onQueued),
  /** FW-C-062: pause or resume every flow. */
  setSupervisorPaused: (paused: boolean, onQueued?: () => void) =>
    ownerWrite<unknown>('POST', `/supervisor/${paused ? 'pause' : 'resume'}`, {}, onQueued),

  async supervisor(): Promise<V.Supervisor> {
    const e = await get<Omit<V.Supervisor, 'data_as_of'>>('/supervisor');
    return { data_as_of: e.as_of, ...e.data };
  },

  /** FW-C-092: ask the AI console about this page. Only the live site answers it; changes come back as proposals. */
  askConsole(question: ConsoleQuestion): Promise<ConsoleAnswer> {
    return post<ConsoleAnswer>('/assistant/console', question);
  },
  /**
   * FW-C-085: ask the setup assistant a question. Only the live site answers it (with its own AI);
   * the caller falls back to built-in answers when this fails. Never send a secret here.
   */
  async askSetupAssistant(question: string, stage: string): Promise<{ answer: string }> {
    return post<{ answer: string }>('/assistant/setup', { question, stage });
  },

  /** FW-C-039: where setup stands. */
  async setup(): Promise<V.Setup> {
    const e = await get<Omit<V.Setup, 'data_as_of'>>('/setup');
    return { data_as_of: e.as_of, ...e.data };
  },

  /** FW-C-094: whether email sending, the Frequency link and Google Analytics are set up on the machine. */
  async connections(): Promise<V.Connections> {
    const e = await get<Omit<V.Connections, 'data_as_of'>>('/connections');
    return { data_as_of: e.as_of, ...e.data };
  },

  async policy(): Promise<V.PolicyFile> {
    const e = await get<W.WPolicy>('/policy');
    return { data_as_of: e.as_of, ...e.data };
  },

  kill: (reason = 'Stopped from the web UI') => post<unknown>('/kill-switch', { reason }),
  release: (reason = 'Released from the web UI') => post<unknown>('/kill-switch/release', { reason }),
};

/* ---------------- neighborhood activation admin (FW-C-034) ----------------
 * The Owner's writes for /v1/flows/neighborhood-activation (LOCAL-API-V1.md). Kept apart from `api`:
 * the Flows page owns the view's full type; FlowAdmin only needs the fields named here. */

export type SendVia = 'founder_email' | 'frequency';
export interface AdminSkipped {
  row: number;
  reason: string;
}
export interface AdminUpload {
  added?: number;
  updated: number;
  skipped: AdminSkipped[];
}
export interface AdminLogEntry {
  at: string;
  action: string;
  summary: string;
}
/** The parts of the flow view FlowAdmin reads. */
export interface FlowAdminView {
  thresholds: Record<string, number>;
  territories: { id: string; name: string; status: string }[];
  decision: { kind: string; territory_id?: string; summary: string };
  leads: {
    id: string;
    name: string;
    kind: string;
    territory_id: string;
    stage: string;
    send_via: SendVia | null;
  }[];
  admin_log?: AdminLogEntry[];
}
export type FlowConfigJson = Record<string, unknown> & { activation: Record<string, number> };

const NA = '/flows/neighborhood-activation';
async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  return ((await (await raw(method, path, body)).json()) as W.Envelope<T>).data;
}

export const flowAdmin = {
  uploadLeads: (csv: string) => send<AdminUpload>('POST', `${NA}/leads`, { format: 'csv', data: csv }),
  uploadMetrics: (csv: string) => send<AdminUpload>('POST', `${NA}/metrics`, { format: 'csv', data: csv }),
  markSent: (id: string, via: SendVia) => send<unknown>('POST', `${NA}/leads/${enc(id)}/touches`, { via }),
  doNotContact: (id: string, reason: string) =>
    send<unknown>('POST', `${NA}/do-not-contact`, { lead_id: id, reason }),
  openRegion: (territoryId: string) => send<unknown>('POST', `${NA}/open`, { territory_id: territoryId }),
  config: async () => (await get<FlowConfigJson>(`${NA}/config`)).data,
  saveConfig: (config: FlowConfigJson) => send<unknown>('PUT', `${NA}/config`, config),
  /** A plain link works: the paired browser's session cookie goes with it. */
  leadsCsvUrl: `${API_BASE}${NA}/leads.csv`,
};

/** FW-C-049: a saved lead hunt, as fwd keeps it in hunts.json. */
export interface LeadHunt {
  id: string;
  name: string;
  looking_for: string;
  region: string;
  areas: string[];
  links: string[];
  every_days: number;
  max_sends: number;
  build: boolean;
  enabled: boolean;
  created_at: string;
  last_run_at: string | null;
}
export interface LeadHuntInput {
  name: string;
  looking_for: string;
  region: string;
  links: string[];
  every_days: number;
  max_sends: number;
  build: boolean;
}

/** The Owner's lead hunts and do-not-contact by address, through fwd's hunt routes. */
export const leadHunts = {
  list: async () => (await get<LeadHunt[]>(`${NA}/hunts`)).data ?? [],
  save: (input: LeadHuntInput, onQueued?: () => void) =>
    ownerWrite<LeadHunt>('POST', `${NA}/hunts`, input, onQueued),
  run: (id: string, onQueued?: () => void) =>
    ownerWrite<{ hunt_id: string; fire_id: string; outcome: string; reason?: string }>(
      'POST',
      `${NA}/hunts/${enc(id)}/run`,
      {},
      onQueued,
    ),
  remove: async (id: string, onQueued?: () => void) => {
    await ownerWrite<unknown>('DELETE', `${NA}/hunts/${enc(id)}`, undefined, onQueued);
  },
  block: (email: string, reason: string, onQueued?: () => void) =>
    ownerWrite<{ blocked: string; already: boolean }>(
      'POST',
      `${NA}/do-not-contact`,
      { email, reason },
      onQueued,
    ),
};

/** FW-C-092: what the AI console sends about the page, and what it gets back. */
export interface ConsoleQuestion {
  question: string;
  page: { path: string; name: string; heading: string; text: string };
  flow: string | null;
  history: { who: 'you' | 'ai'; text: string }[];
}
export interface ConsoleProposal {
  id: string;
  summary: string;
  method: 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  kind: string;
  flow: string;
}
export interface ConsoleAnswer {
  answer: string;
  proposals: ConsoleProposal[];
  can_change: boolean;
}
