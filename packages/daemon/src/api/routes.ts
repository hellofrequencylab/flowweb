// Route table for /v1 (docs/api/LOCAL-API-V1.md). Read routes query the database through a
// read-only Reader. Writes: POST /v1/pair, and POST /v1/runs (the CLI hands a run to fwd; the
// pipeline itself is deps.runs). Later write routes answer 501 with the row that adds them. No
// business logic lives here.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { type Reader, sha256Hex } from '@fw/eventlog';
import type { PairingStore, Principal } from '../auth.ts';
import * as crm from '../flows/crm.ts';
import * as hunts from '../flows/hunts.ts';
import * as leads from '../flows/leads.ts';
import * as localPulse from '../flows/local-pulse.ts';
import * as localSaturation from '../flows/local-saturation.ts';
import * as neighborhoodActivation from '../flows/neighborhood-activation.ts';
import * as naAdmin from '../flows/neighborhood-admin.ts';
import * as outcomes from '../flows/outcomes.ts';
import * as paidAds from '../flows/paid-ads.ts';
import * as adsPull from '../flows/paid-ads-ga4.ts';
import * as review from '../flows/review.ts';
import { reviewSummary } from '../flows/review-summary.ts';
import { type BatchResult, dueTouches, loadSequence } from '../flows/sequence.ts';
import { isSkipReason, recordSkip, todaySize, todayView } from '../flows/today.ts';
import { type DraftView, editDraft, listDrafts, markDraft } from '../overseer/drafts.ts';
import { perDayFor, readSettings, SupervisorError, shippedFlows, supervisorView } from '../overseer/index.ts';
import type { RewriteProposal } from '../overseer/rewrite.ts';
import { type RunHost, RunHostStoppingError } from '../run-host.ts';
import { isInside, RUN_ID_RE } from '../runtime/paths.ts';
import { setupReport } from '../setup/index.ts';
import { spendRollup } from '../spend.ts';
import { rowIdOf } from './codes.ts';
import { checkSender, connectionsOf, saveSender } from './connections.ts';
import {
  ApiError,
  envelope,
  headSeq,
  invalid,
  isoParam,
  limitOf,
  nonNegInt,
  notFound,
  oneOf,
  paged,
  pageOf,
  readJsonBody,
  sendJson,
  sendJsonFlushed,
} from './http.ts';
import { Router } from './router.ts';
import {
  CARD_SELECT,
  cardRow,
  evidenceRow,
  JSON_COLUMNS,
  ledgerRow,
  PROJECT_SELECT,
  parseJsonColumns,
  RUN_SELECT,
  runRow,
  URGENCY_ORDER,
} from './rows.ts';
import { streamEvents } from './sse.ts';
import { type ChainStatus, statusOf } from './status.ts';

/** Flows GET /v1/flows/{key} serves, by key. Each loads from disk and returns its view, or null. */
const FLOWS: Record<string, (repoRoot: string, fwHome: string, now: Date) => unknown> = {
  [localSaturation.FLOW_KEY]: (repo, home, now) => {
    const f = localSaturation.loadFlow(repo, home, now);
    return f && localSaturation.flowView(f.cfg, f.state, f.budget, f.stream);
  },
  [neighborhoodActivation.FLOW_KEY]: (repo, home, now) => {
    const f = neighborhoodActivation.loadFlow(repo, home, now);
    const view = f && neighborhoodActivation.flowView(f.cfg, f.state, f.budget, f.stream, now);
    return view && { ...view, admin_log: naAdmin.readAdminLog(home) };
  },
  [localPulse.FLOW_KEY]: localPulse.flowView,
  [paidAds.FLOW_KEY]: (repo, home, now) => {
    const f = paidAds.loadFlow(repo, home);
    if (!f) return null;
    const g = adsPull.ga4Of(f.cfg);
    const pull = g && {
      property_id: g.property_id,
      every_hours: g.pull_every_hours,
      last: adsPull.readPullStatus(home),
    };
    return { ...paidAds.flowView(f.cfg, f.stream, f.days, now), pull };
  },
};

export interface ApiDeps {
  reader: Reader;
  fwHome: string;
  repoRoot: string;
  version: string;
  startedAt: string;
  chain: () => ChainStatus;
  pairing: PairingStore;
  ssePollMs: number;
  sseHeartbeatMs: number;
  /** Called by the server for every open SSE response so shutdown can end them. */
  trackStream: (end: () => void) => () => void;
  /** The pipeline fwd hosts (POST /v1/runs). Absent: the route answers 501. */
  runs?: RunsApi;
  /** The Supervisor's Owner controls, on fwd's writer (FW-C-033). Absent: those routes answer 501. */
  supervisor?: SupervisorControls;
  /** FW-C-039: project writes on fwd's writer. Absent: those routes answer 501. */
  projects?: ProjectControls;
  /** WS-P0-021: fw ledger close on fwd's writer, for when fwd holds the lock. Absent: 501. */
  ledger?: LedgerControls;
}

export interface LedgerControls {
  close(code: string, mergedSha: string, repoDir: string): Promise<unknown>;
  /** Owner parks a row with a reason. Optional so an older host still loads. */
  park?(code: string, reason: string): Promise<unknown>;
}

/** FW-C-039: the project writes the CLI hands to fwd while fwd holds the writer. */
export interface ProjectControls {
  add(input: Row): unknown;
  label(ref: string, change: { brand?: string | null; category?: string | null }): unknown;
  brief(ref: string, answers: Row): unknown;
}

export interface SupervisorControls {
  setFlowEnabled(key: string, enabled: boolean): { changed: boolean };
  setPaused(paused: boolean): { changed: boolean };
  /** FW-C-035: autopilot needs the flow's current confirm hash. */
  setDial(key: string, stop: string, confirm?: string): { changed: boolean };
  /** FW-C-063: when the flow runs each morning, and how many new people it reaches a day. */
  setSchedule?(key: string, time: string, days: string): { changed: boolean };
  setIntensity?(key: string, body: Record<string, unknown>): { changed: boolean };
  /** FW-C-086: which AI account the flow uses: { account: claude_plan|anthropic_key|chatgpt_plan|openai_key }. */
  setFlowAi?(key: string, body: Record<string, unknown>): { changed: boolean };
  /** FW-C-038: fire the flow's stream by hand; the Supervisor decides it like any fire. */
  runFlow?(key: string): Promise<{ fire_id: string; outcome: string; reason?: string }>;
  /** FW-C-097: flow cycles in flight now, by flow key, so the Supervisor can say a flow is running. */
  inFlight?(): Record<string, number>;
  /** FW-C-046: the Owner approves or rejects one cycle draft. */
  approveDraft?(key: string, id: string): DraftView;
  rejectDraft?(key: string, id: string): DraftView;
  /** FW-C-104: the Owner approves a batch of email sequence touches for the sender. */
  batchApprove?(key: string, draftIds: unknown): BatchResult;
  /** FW-C-051: a proposal from the flow's engine; the draft is not changed. */
  rewriteDraft?(key: string, id: string, body: Record<string, unknown>): Promise<RewriteProposal>;
}

/** The body of POST /v1/runs, checked. */
export interface RunStartBody {
  code: string;
  repo_dir: string;
  adapter?: string;
  scenario?: string;
  base?: string;
  host?: string;
  max_wall_clock_s?: number;
}

export interface RunsApi {
  host: RunHost;
  /** Runs the pipeline to its end under signal and returns the run report. */
  start(body: RunStartBody, signal: AbortSignal): Promise<unknown>;
}

function runStartBody(body: Record<string, unknown>): RunStartBody {
  const str = (k: string, required = false): string | undefined => {
    const v = body[k];
    if (v === undefined || v === null) {
      if (required) throw invalid(`${k} is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v === '') throw invalid(`${k} must be a non-empty string`);
    return v;
  };
  const known = ['code', 'repo_dir', 'adapter', 'scenario', 'base', 'host', 'max_wall_clock_s'];
  const extra = Object.keys(body).filter((k) => !known.includes(k));
  if (extra.length) throw invalid(`unknown field(s): ${extra.join(', ')}`);
  const out: RunStartBody = { code: str('code', true)!, repo_dir: str('repo_dir', true)! };
  if (!isAbsolute(out.repo_dir)) throw invalid('repo_dir must be an absolute path');
  for (const k of ['adapter', 'scenario', 'base', 'host'] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = v;
  }
  const wall = body.max_wall_clock_s;
  if (wall !== undefined && wall !== null) {
    if (typeof wall !== 'number' || !Number.isInteger(wall) || wall <= 0)
      throw invalid('max_wall_clock_s must be a positive whole number');
    out.max_wall_clock_s = wall;
  }
  return out;
}

/** A kernel error (LedgerError, PipelineError...) as an API error; its own code goes in details.fw_code. */
function kernelError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const code = (e as { code?: unknown })?.code;
  if (typeof code !== 'string')
    return new ApiError(500, 'internal', 'internal error', { reason: (e as Error)?.message ?? String(e) });
  const details = (e as { details?: unknown }).details;
  const extra = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
  const message = (e as Error).message;
  if (code === 'NOT_FOUND') return new ApiError(404, 'not_found', message, { ...extra, fw_code: code });
  if (code === 'UNAVAILABLE') return new ApiError(503, 'unavailable', message, { ...extra, fw_code: code });
  return new ApiError(400, 'validation_failed', message, { ...extra, fw_code: code });
}

type NaFlow = NonNullable<ReturnType<typeof neighborhoodActivation.loadFlow>>;
type NaWrite = (f: NaFlow, body: Row, params: Record<string, string>, now: Date) => naAdmin.Change;
const ADMIN_CODES = { 400: 'validation_failed', 404: 'not_found', 409: 'conflict' } as const;
/** The neighborhood activation admin writes: method, path under the flow, admin log action, change. */
const NA_WRITES: [string, string, naAdmin.AdminAction, NaWrite][] = [
  ['POST', 'leads', 'leads', (f, b, _p, now) => naAdmin.importLeads(f.cfg, f.state, b, now)],
  ['POST', 'metrics', 'metrics', (f, b) => naAdmin.importMetrics(f.cfg, f.state, b)],
  ['POST', 'leads/{id}/touches', 'touch', (f, b, p, now) => naAdmin.addTouch(f.state, p.id ?? '', b, now)],
  ['POST', 'do-not-contact', 'do_not_contact', (f, b) => naAdmin.addDoNotContact(f.state, b)],
  ['POST', 'open', 'open', (f, b) => naAdmin.openTerritory(f.cfg, f.state, String(b.territory_id ?? ''))],
  ['PUT', 'config', 'config', (f, b) => naAdmin.saveConfig(f.cfg, f.state, b)],
];

/**
 * The Owner's admin routes for the neighborhood activation flow. A write applies one pure change from
 * flows/neighborhood-admin.ts, writes state.json or config.json atomically and appends to admin-log.jsonl.
 * A refusal writes nothing. Reading the body is the only await, so two writes never interleave.
 */
function addFlowAdminRoutes(r: Router, deps: ApiDeps): void {
  const base = `/v1/flows/${neighborhoodActivation.FLOW_KEY}`;
  const load = (now: Date) => {
    const f = neighborhoodActivation.loadFlow(deps.repoRoot, deps.fwHome, now);
    if (!f) throw notFound('flow', neighborhoodActivation.FLOW_KEY);
    return f;
  };
  for (const [method, path, action, change] of NA_WRITES) {
    r.add(method, `${base}/${path}`, async ({ req, params }) => {
      const body = await readJsonBody(req, 2 * 1024 * 1024); // uploads: up to 2 MB
      const now = new Date();
      let out: naAdmin.Change;
      try {
        out = change(load(now), body, params, now);
      } catch (e) {
        if (!(e instanceof naAdmin.AdminError)) throw e;
        throw new ApiError(e.status, ADMIN_CODES[e.status], e.message, e.details);
      }
      const dir = naAdmin.adminDir(deps.fwHome);
      if (out.state) naAdmin.writeJsonAtomic(join(dir, 'state.json'), out.state);
      if (out.config) naAdmin.writeJsonAtomic(join(dir, 'config.json'), out.config);
      if (out.state || out.config)
        naAdmin.appendAdminLog(deps.fwHome, { at: now.toISOString(), action, summary: out.summary });
      return envelope(deps.reader, () => ({ data: out.data }));
    });
  }
  r.get(`${base}/config`, () => envelope(deps.reader, () => ({ data: load(new Date()).cfg })));
  addHuntRoutes(r, deps, base, load);
  // FW-C-055: what became of the people the flow reached, pulled from Frequency (daily, or now).
  r.get(`${base}/outcomes`, () =>
    envelope(deps.reader, () => ({ data: outcomes.readOutcomes(deps.fwHome) })),
  );
  r.post(`${base}/outcomes/pull`, async () => {
    try {
      const data = await outcomes.pullOutcomes({
        repoRoot: deps.repoRoot,
        fwHome: deps.fwHome,
        env: process.env,
      });
      return envelope(deps.reader, () => ({ data }));
    } catch (e) {
      if (!(e instanceof outcomes.PullError)) throw e;
      throw new ApiError(e.status, e.status === 409 ? 'conflict' : 'unavailable', e.message);
    }
  });
  // FW-C-065: post every email draft's state to Frequency's CRM now (fwd also does it daily and after a mark).
  r.post(`${base}/crm/sync`, async () => {
    const data = await crm.syncAll({ repoRoot: deps.repoRoot, fwHome: deps.fwHome, env: process.env });
    return envelope(deps.reader, () => ({ data }));
  });
  // FW-C-056: the weekly review: a scorecard per hunt and shifts toward what works.
  r.get(`${base}/review`, () => envelope(deps.reader, () => ({ data: review.readReview(deps.fwHome) })));
  r.post(`${base}/review/run`, () => {
    const data = review.runReview({ reader: deps.reader, repoRoot: deps.repoRoot, fwHome: deps.fwHome });
    return envelope(deps.reader, () => ({ data }));
  });
  for (const action of ['apply', 'dismiss'] as const)
    r.post(`${base}/review/shifts/{id}/${action}`, ({ params }) => {
      try {
        const data = review.decideShift(deps.fwHome, params.id ?? '', action);
        return envelope(deps.reader, () => ({ data }));
      } catch (e) {
        if (!(e instanceof review.ReviewError)) throw e;
        throw new ApiError(e.status, e.status === 404 ? 'not_found' : 'conflict', e.message);
      }
    });
  r.get(`${base}/leads.csv`, ({ req, res }) => {
    const now = new Date();
    const f = load(now);
    const text = naAdmin.leadsCsv(f.cfg, f.state, now);
    const file = `attachment; filename="${neighborhoodActivation.FLOW_KEY}-leads.csv"`;
    const type = { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': file };
    res.writeHead(200, { ...type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(req.method === 'HEAD' ? undefined : text);
    return undefined;
  });
}

/**
 * FW-C-103: a flow's lead graph. GET refreshes it from the hunt drafts and lists the nodes (?state=
 * proposed|approved|dropped); approve and drop are the Owner's tap; paste adds people met in person.
 */
function addLeadRoutes(r: Router, deps: ApiDeps): void {
  const base = '/v1/flows/{key}/leads';
  const opts = (key: string | undefined) => {
    if (!key || !Object.hasOwn(FLOWS, key)) throw notFound('flow', key);
    const na = key === neighborhoodActivation.FLOW_KEY;
    const cfg = na ? neighborhoodActivation.loadFlow(deps.repoRoot, deps.fwHome)?.cfg.leads : undefined;
    return { fwHome: deps.fwHome, flow: key, rules: leads.rulesOf(cfg) };
  };
  r.get(base, ({ params, query }) => {
    const want = oneOf(query, 'state', ['proposed', 'approved', 'dropped'] as const);
    const g = leads.refreshLeads(opts(params.key));
    return envelope(deps.reader, () => ({ data: g.nodes.filter((n) => !want || n.state === want) }));
  });
  r.post(`${base}/paste`, async ({ req, params }) => {
    const body = await readJsonBody(req);
    if (typeof body.text !== 'string' || !body.text.trim()) throw invalid('text is required');
    const town = typeof body.town === 'string' && body.town.trim() ? body.town.trim() : null;
    const extra = leads.parsePaste(body.text, new Date(), town);
    const g = leads.refreshLeads({ ...opts(params.key), extra });
    return envelope(deps.reader, () => ({ data: leads.nodesFor(g, extra) }));
  });
  for (const [action, state] of [
    ['approve', 'approved'],
    ['drop', 'dropped'],
  ] as const)
    r.post(`${base}/{id}/${action}`, ({ params }) => {
      try {
        const data = leads.decideLead({ ...opts(params.key), id: params.id ?? '', state });
        return envelope(deps.reader, () => ({ data }));
      } catch (e) {
        if (!(e instanceof leads.LeadError)) throw e;
        throw new ApiError(e.status, e.status === 404 ? 'not_found' : 'conflict', e.message);
      }
    });
}

/**
 * FW-C-041: the Owner's saved lead hunts. Save, list and delete write hunts.json under the flow's
 * folder and the admin log. Run asks for the hunt in the next cycle and fires the flow by hand through
 * the scheduler, so the Supervisor still decides it.
 */
function addHuntRoutes(r: Router, deps: ApiDeps, base: string, load: (now: Date) => NaFlow): void {
  const log = (now: Date, summary: string) =>
    naAdmin.appendAdminLog(deps.fwHome, { at: now.toISOString(), action: 'hunt', summary });
  const find = (id: string) => {
    const list = hunts.loadHunts(deps.fwHome);
    const h = list.find((x) => x.id === id);
    if (!h) throw notFound('hunt', id);
    return { list, h };
  };
  r.get(`${base}/hunts`, () => envelope(deps.reader, () => ({ data: hunts.loadHunts(deps.fwHome) })));
  r.post(`${base}/hunts`, async ({ req, res }) => {
    const body = await readJsonBody(req);
    const now = new Date();
    let h: hunts.Hunt;
    try {
      h = hunts.newHunt(load(now).cfg, body, now);
    } catch (e) {
      if (!(e instanceof naAdmin.AdminError)) throw e;
      throw new ApiError(e.status, ADMIN_CODES[e.status], e.message, e.details);
    }
    hunts.saveHunts(deps.fwHome, [...hunts.loadHunts(deps.fwHome), h]);
    log(now, `Saved the hunt "${h.name}".`);
    sendJson(res, 201, { data: h });
    return undefined;
  });
  r.add('DELETE', `${base}/hunts/{id}`, ({ params }) => {
    const { list, h } = find(params.id ?? '');
    hunts.saveHunts(
      deps.fwHome,
      list.filter((x) => x.id !== h.id),
    );
    log(new Date(), `Deleted the hunt "${h.name}".`);
    return envelope(deps.reader, () => ({ data: { deleted: h.id } }));
  });
  r.post(`${base}/hunts/{id}/run`, async ({ params }) => {
    const { list, h } = find(params.id ?? '');
    const c = deps.supervisor;
    if (!c?.runFlow) throw new ApiError(501, 'not_implemented', 'this fwd cannot run flows by hand');
    const now = new Date().toISOString();
    hunts.saveHunts(
      deps.fwHome,
      list.map((x) => (x.id === h.id ? { ...x, requested_at: now } : x)),
    );
    try {
      const out = await c.runFlow(neighborhoodActivation.FLOW_KEY);
      return envelope(deps.reader, () => ({ data: { hunt_id: h.id, ...out } }));
    } catch (e) {
      if (e instanceof SupervisorError) throw new ApiError(404, 'not_found', e.message);
      throw kernelError(e);
    }
  });
}

/** The principal of the current request, set by the server before the handler runs. */
export const principalOf = new WeakMap<object, Principal>();

const LEDGER_STATUSES = [
  'open',
  'ready',
  'claimed',
  'running',
  'verifying',
  'awaiting_approval',
  'merging',
  'watching',
  'done',
  'blocked',
  'parked',
  'regressed',
] as const;
const RUN_STATUSES = [
  'queued',
  'starting',
  'running',
  'paused',
  'validating',
  'succeeded',
  'failed',
  'timed_out',
  'killed',
  'cancelled',
] as const;
const CARD_STATUSES = ['open', 'snoozed', 'answered', 'expired', 'withdrawn'] as const;
const REPORT_KINDS = ['daily', 'weekly', 'on_change', 'run'] as const;
/** The groupings docs/api/LOCAL-API-V1.md lists for GET /v1/spend. */
const API_SPEND_GROUPS = ['project', 'agent', 'vendor'] as const;

type Row = Record<string, unknown>;

/** Rows that add each write route the contract lists (C0 answers 501 for all of them). */
export const NOT_IMPLEMENTED: ReadonlyArray<[string, string, string, string]> = [
  ['POST', '/v1/approvals/{id}/respond', 'FW-C-010', 'C1'],
  ['POST', '/v1/decision-cards/{id}/answer', 'FW-C-021', 'C1/C2'],
  ['POST', '/v1/decision-cards/{id}/snooze', 'FW-C-021', 'C2'],
  ['POST', '/v1/kill-switch', 'FW-C-012', 'C1'],
  ['POST', '/v1/kill-switch/release', 'FW-C-012', 'C1'],
  ['POST', '/v1/ledger/rows/{id}/accept', 'FW-C-027', 'C2'],
  ['DELETE', '/v1/session', 'FW-C-019', 'C2'],
];

function policyFile(fwHome: string, repoRoot: string): { path: string; inRepo: boolean } {
  for (const p of [join(fwHome, 'policy', 'core-policy.yaml'), join(fwHome, 'config', 'core-policy.yaml')]) {
    if (existsSync(p)) return { path: p, inRepo: false };
  }
  return { path: join(repoRoot, 'contracts-core', 'core-policy.yaml'), inRepo: true };
}

function gitHead(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** The diff a bundle points at: `body.diff.ref` or `intent_payload.rendered_ref` under FW_HOME, else runs/<run>/diff.patch. */
function storedDiff(fwHome: string, bundle: Row): { hash: string; candidates: string[] } | undefined {
  const body = (bundle.body ?? {}) as Row;
  const diff = (body.diff ?? {}) as Row;
  const intent = (body.intent_payload ?? {}) as Row;
  const hash =
    typeof diff.hash === 'string'
      ? diff.hash
      : intent.format === 'diff' && typeof intent.payload_hash === 'string'
        ? intent.payload_hash
        : undefined;
  if (hash === undefined) return undefined;
  const candidates: string[] = [];
  if (typeof diff.ref === 'string') {
    candidates.push(isAbsolute(diff.ref) ? diff.ref : resolve(fwHome, diff.ref));
  }
  // `fw run start` bundles: intent_payload.rendered_ref is the stored diff, relative to FW_HOME.
  if (intent.format === 'diff' && typeof intent.rendered_ref === 'string') {
    const p = intent.rendered_ref;
    candidates.push(isAbsolute(p) ? p : resolve(fwHome, p));
  }
  const ref = bundle.subject_ref;
  if (typeof ref === 'string' && RUN_ID_RE.test(ref))
    candidates.push(join(fwHome, 'runs', ref, 'diff.patch'));
  return { hash, candidates: candidates.filter((p) => isInside(fwHome, p)) };
}

export function buildRouter(deps: ApiDeps): Router {
  const { reader } = deps;
  const r = new Router();
  const env = (read: () => { data: unknown; next_cursor?: string | null }) => envelope(reader, read);

  // ---- pairing and session --------------------------------------------------------------
  r.post('/v1/pair', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const label =
      typeof body.device_label === 'string'
        ? body.device_label.slice(0, 80)
        : typeof req.headers['user-agent'] === 'string'
          ? req.headers['user-agent'].slice(0, 80)
          : null;
    const out = deps.pairing.pair(body.code, label);
    if ('refused' in out) throw new ApiError(401, 'unauthorized', out.refused);
    sendJson(
      res,
      200,
      {
        data: { paired_at: out.session.paired_at, device_label: out.session.device_label },
        as_of: new Date().toISOString(),
        head_seq: headSeq(reader),
        next_cursor: null,
      },
      { 'set-cookie': deps.pairing.sessionCookie(out.token) },
    );
    return undefined;
  });

  r.get('/v1/session', ({ req }) =>
    env(() => {
      const p = principalOf.get(req);
      if (p?.kind === 'session') {
        return { data: { paired_at: p.session.paired_at, device_label: p.session.device_label } };
      }
      return { data: { paired_at: null, device_label: p?.kind === 'cli' ? 'cli' : null } };
    }),
  );

  // ---- status and policy ------------------------------------------------------------------
  r.get('/v1/status', () => env(() => ({ data: statusOf(deps) })));
  // FW-C-039: where the Owner is in setting up. fwd answering this is the machine step itself.
  r.get('/v1/setup', () =>
    env(() => ({
      data: setupReport({ reader, fwHome: deps.fwHome, repoRoot: deps.repoRoot, fwdUp: true }),
    })),
  );

  // FW-C-094: whether email sending, the Frequency link and Google Analytics are set up here. Presence only.
  r.get('/v1/connections', () => env(() => ({ data: connectionsOf(deps.fwHome, deps.repoRoot) })));
  // FW-C-095: the sender's settings from Settings (a browser session or the CLI). Never a password.
  r.post('/v1/connections/email', async ({ req }) => {
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth' && p?.kind !== 'session')
      throw new ApiError(403, 'forbidden', 'sign in to change the sender settings');
    const checked = checkSender(await readJsonBody(req));
    if ('error' in checked) throw new ApiError(400, 'validation_failed', checked.error);
    saveSender(deps.fwHome, checked.values);
    return env(() => ({ data: connectionsOf(deps.fwHome, deps.repoRoot) }));
  });

  r.get('/v1/policy', () =>
    env(() => {
      const f = policyFile(deps.fwHome, deps.repoRoot);
      let bytes: Buffer;
      try {
        bytes = readFileSync(f.path);
      } catch {
        throw notFound('policy file', f.path);
      }
      return {
        data: {
          path: f.path,
          commit: f.inRepo ? gitHead(deps.repoRoot) : null,
          sha256: sha256Hex(bytes),
          text: bytes.toString('utf8'),
        },
      };
    }),
  );

  // ---- flows (read-only) ----------------------------------------------------------------
  // FW-C-072: what's working, from the flow's latest weekly review.
  r.get('/v1/flows/{key}/review/summary', ({ params }) =>
    env(() => {
      const key = params.key ?? '';
      if (!Object.hasOwn(FLOWS, key)) throw notFound('flow', params.key);
      return { data: reviewSummary(deps.fwHome, key) };
    }),
  );
  r.get('/v1/flows/{key}', ({ params }) =>
    env(() => {
      const key = params.key ?? '';
      const view = FLOWS[key]?.(deps.repoRoot, deps.fwHome, new Date()) as Record<string, unknown> | null;
      if (!view) throw notFound('flow', params.key);
      // FW-C-064: on/off is the Owner's Supervisor switch, not the shipped stream.json (always off),
      // and the waiting count is the drafts that wait for the Owner, not a counter nothing writes.
      const enabled = readSettings(reader).flows[key]?.enabled === true;
      const waiting = () =>
        listDrafts(deps.repoRoot, deps.fwHome, key).filter((x) => x.status === 'waiting_for_owner').length;
      const live = 'awaiting_owner_total' in view ? { awaiting_owner_total: waiting() } : {};
      return { data: { ...view, enabled, ...live } };
    }),
  );
  addFlowAdminRoutes(r, deps);
  addLeadRoutes(r, deps);
  localPulse.addLocalPulseRoutes(r, deps);

  // ---- supervisor (FW-C-033) ----------------------------------------------------------------
  const supView = () => ({
    reader,
    repoRoot: deps.repoRoot,
    fwHome: deps.fwHome,
    ...(deps.supervisor?.inFlight ? { inFlight: () => deps.supervisor?.inFlight?.() ?? {} } : {}),
  });
  r.get('/v1/supervisor', () => env(() => ({ data: supervisorView(supView()) })));
  // The Owner's controls (FW-C-062): the CLI token or the paired browser session. Autopilot still
  // needs the confirm hash, and the hosted site reaches these only through the relay's CLI token.
  const requireOwner = (req: object) => {
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth' && p?.kind !== 'session')
      throw new ApiError(401, 'unauthorized', 'pair this browser or use the CLI token');
  };
  const ownerControl = (req: object, act: (c: SupervisorControls) => { changed: boolean }) => {
    const c = deps.supervisor;
    if (!c) throw new ApiError(501, 'not_implemented', 'this fwd does not host the Supervisor controls');
    requireOwner(req);
    try {
      const out = act(c);
      return env(() => ({
        data: {
          changed: out.changed,
          ...supervisorView(supView()),
        },
      }));
    } catch (e) {
      if (e instanceof SupervisorError) {
        if (e.code === 'CONFIRM_REQUIRED') {
          const flow = String(e.details.flow ?? '');
          const hash = String(e.details.confirm_hash ?? '');
          throw new ApiError(
            409,
            'conflict',
            `${e.message} Run: fw supervisor dial ${flow} autopilot --confirm ${hash}`,
            { confirm_hash: hash },
          );
        }
        if (e.code === 'INVALID') throw new ApiError(400, 'validation_failed', e.message);
        throw new ApiError(404, 'not_found', e.message);
      }
      throw kernelError(e);
    }
  };
  r.post('/v1/supervisor/pause', ({ req }) => ownerControl(req, (c) => c.setPaused(true)));
  r.post('/v1/supervisor/resume', ({ req }) => ownerControl(req, (c) => c.setPaused(false)));
  r.post('/v1/supervisor/flows/{key}/enable', ({ req, params }) =>
    ownerControl(req, (c) => c.setFlowEnabled(params.key ?? '', true)),
  );
  r.post('/v1/supervisor/flows/{key}/disable', ({ req, params }) =>
    ownerControl(req, (c) => c.setFlowEnabled(params.key ?? '', false)),
  );
  // FW-C-038: run a flow now. The fire goes through the scheduler, so the Supervisor decides it.
  r.post('/v1/supervisor/flows/{key}/run', async ({ req, params }) => {
    const c = deps.supervisor;
    if (!c?.runFlow) throw new ApiError(501, 'not_implemented', 'this fwd cannot run flows by hand');
    requireOwner(req);
    try {
      const out = await c.runFlow(params.key ?? '');
      return env(() => ({ data: out }));
    } catch (e) {
      if (e instanceof SupervisorError) throw new ApiError(404, 'not_found', e.message);
      throw kernelError(e);
    }
  });
  // FW-C-035: the dial. Body { stop: draft|copilot|autopilot, confirm?: hash }.
  r.post('/v1/supervisor/flows/{key}/dial', async ({ req, params }) => {
    const body = await readJsonBody(req);
    const stop = typeof body.stop === 'string' ? body.stop : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : undefined;
    return ownerControl(req, (c) => c.setDial(params.key ?? '', stop, confirm));
  });

  // FW-C-063: the morning run time { time: 'HH:MM', days: daily|weekdays } and the people a day
  // { per_day, auto, min, max }.
  r.post('/v1/supervisor/flows/{key}/schedule', async ({ req, params }) => {
    const body = await readJsonBody(req);
    return ownerControl(req, (c) => {
      if (!c.setSchedule)
        throw new ApiError(501, 'not_implemented', 'this fwd cannot change a flow schedule');
      return c.setSchedule(params.key ?? '', String(body.time ?? ''), String(body.days ?? ''));
    });
  });
  r.post('/v1/supervisor/flows/{key}/intensity', async ({ req, params }) => {
    const body = await readJsonBody(req);
    return ownerControl(req, (c) => {
      if (!c.setIntensity)
        throw new ApiError(501, 'not_implemented', 'this fwd cannot change a flow intensity');
      return c.setIntensity(params.key ?? '', body);
    });
  });

  // FW-C-086: which AI account the flow's runs use. The key stays in the keychain; this only picks one.
  r.post('/v1/supervisor/flows/{key}/ai', async ({ req, params }) => {
    const body = await readJsonBody(req);
    return ownerControl(req, (c) => {
      if (!c.setFlowAi)
        throw new ApiError(501, 'not_implemented', 'this fwd cannot change a flow AI account');
      return c.setFlowAi(params.key ?? '', body);
    });
  });

  // FW-C-046: Copilot. The Owner lists a flow's cycle drafts and approves or rejects each one
  // (FW-C-062: from the paired browser too).
  const ownerOnly = requireOwner;
  const draftError = (e: unknown) => {
    if (!(e instanceof SupervisorError)) return kernelError(e);
    if (e.code === 'CONFLICT') return new ApiError(409, 'conflict', e.message, { reason: e.message });
    if (e.code === 'INVALID') return new ApiError(400, 'validation_failed', e.message);
    return new ApiError(404, 'not_found', e.message);
  };
  r.get('/v1/supervisor/flows/{key}/drafts', ({ req, params }) => {
    ownerOnly(req);
    try {
      const data = listDrafts(deps.repoRoot, deps.fwHome, params.key ?? '');
      return env(() => ({ data }));
    } catch (e) {
      throw draftError(e);
    }
  });
  // FW-C-105: Today, the ranked list of the morning's actions. Owner only, like the drafts it holds.
  r.get('/v1/flows/{key}/today', ({ req, params, query }) => {
    ownerOnly(req);
    const key = params.key ?? '';
    if (!shippedFlows(deps.repoRoot).some((f) => f.key === key)) throw notFound('flow', params.key);
    const now = new Date();
    const size = todaySize(perDayFor(reader, deps.fwHome, key, now), query.get('size'));
    return env(() => ({ data: todayView({ fwHome: deps.fwHome, flow: key, size, now }) }));
  });
  // FW-C-050: the Owner changes a draft's subject and text before it goes out.
  r.post('/v1/supervisor/flows/{key}/drafts/{id}/edit', async ({ req, params }) => {
    ownerOnly(req);
    const body = await readJsonBody(req);
    try {
      const data = editDraft({
        repoRoot: deps.repoRoot,
        fwHome: deps.fwHome,
        flow: params.key ?? '',
        id: params.id ?? '',
        subject: body.subject,
        body: body.body,
      });
      return env(() => ({ data }));
    } catch (e) {
      throw draftError(e);
    }
  });
  // FW-C-054: the Owner says what happened to a draft sent by hand; declined is an opt-out.
  r.post('/v1/supervisor/flows/{key}/drafts/{id}/mark', async ({ req, params }) => {
    ownerOnly(req);
    const body = await readJsonBody(req);
    try {
      const data = markDraft({
        repoRoot: deps.repoRoot,
        fwHome: deps.fwHome,
        flow: params.key ?? '',
        id: params.id ?? '',
        outcome: body.outcome,
      });
      // FW-C-065: tell Frequency's CRM what happened. Never blocks or fails the mark.
      void crm.syncDraft({ repoRoot: deps.repoRoot, fwHome: deps.fwHome, env: process.env, id: data.id });
      return env(() => ({ data }));
    } catch (e) {
      throw draftError(e);
    }
  });
  // FW-C-051: the flow's engine proposes a rewrite of one draft from the Owner's instruction.
  r.post('/v1/supervisor/flows/{key}/drafts/{id}/rewrite', async ({ req, params }) => {
    ownerOnly(req);
    const body = await readJsonBody(req);
    const c = deps.supervisor;
    if (!c?.rewriteDraft) throw new ApiError(501, 'not_implemented', 'this fwd does not host draft rewrites');
    try {
      const data = await c.rewriteDraft(params.key ?? '', params.id ?? '', body);
      return env(() => ({ data }));
    } catch (e) {
      throw draftError(e);
    }
  });
  for (const action of ['approve', 'reject'] as const)
    r.post(`/v1/supervisor/flows/{key}/drafts/{id}/${action}`, async ({ req, params }) => {
      ownerOnly(req);
      const c = deps.supervisor;
      const act = action === 'approve' ? c?.approveDraft : c?.rejectDraft;
      if (!c || !act)
        throw new ApiError(501, 'not_implemented', 'this fwd does not host the Copilot controls');
      // FW-C-105: a skip from Today rejects with a reason, recorded for the weekly review.
      const reason =
        action === 'reject' && req.headers['content-type'] ? (await readJsonBody(req)).reason : undefined;
      if (reason !== undefined && !isSkipReason(reason))
        throw new ApiError(
          400,
          'validation_failed',
          'reason must be wrong_niche, not_local, not_a_fit or on_frequency',
        );
      try {
        const data = act.call(c, params.key ?? '', params.id ?? '');
        if (reason !== undefined)
          recordSkip({ fwHome: deps.fwHome, flow: params.key ?? '', draftId: params.id ?? '', reason });
        return env(() => ({ data }));
      } catch (e) {
        throw draftError(e);
      }
    });

  // FW-C-104: the outreach sequence. GET lists the touches due now and every lead's state; POST hands
  // an approved batch of email touches to the sender, capped a day.
  r.get('/v1/flows/{key}/sequence', ({ req, params }) => {
    ownerOnly(req);
    const key = params.key ?? '';
    if (!Object.hasOwn(FLOWS, key)) throw notFound('flow', params.key);
    return env(() => {
      const due = dueTouches(key, new Date(), deps.fwHome);
      return { data: { due, leads: Object.values(loadSequence(deps.fwHome, key).leads) } };
    });
  });
  r.post('/v1/flows/{key}/batch/approve', async ({ req, params }) => {
    ownerOnly(req);
    const body = await readJsonBody(req);
    const c = deps.supervisor;
    if (!c?.batchApprove) throw new ApiError(501, 'not_implemented', 'this fwd does not host batch approval');
    try {
      const data = c.batchApprove(params.key ?? '', body.draft_ids);
      return env(() => ({ data }));
    } catch (e) {
      throw draftError(e);
    }
  });

  r.get('/v1/status-reports', ({ query }) => {
    const kind = oneOf(query, 'kind', REPORT_KINDS);
    const page = pageOf(query);
    return env(() =>
      paged(page, (limit, offset) =>
        reader
          .all<Row>(
            `SELECT * FROM status_reports WHERE (@kind IS NULL OR kind = @kind)
              ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
            { kind: kind ?? null, limit, offset },
          )
          .map((row) => parseJsonColumns(row, JSON_COLUMNS.status_reports)),
      ),
    );
  });

  // ---- projects -----------------------------------------------------------------------------
  r.get('/v1/projects', ({ query }) => {
    const page = pageOf(query);
    const params = { brand: query.get('brand') || null, category: query.get('category') || null };
    return env(() =>
      paged(page, (limit, offset) =>
        reader
          .all<Row>(
            `SELECT * FROM (${PROJECT_SELECT}) x
            WHERE (@brand IS NULL OR lower(trim(x.brand)) = lower(trim(@brand)))
              AND (@category IS NULL OR x.category = lower(@category))
            ORDER BY x.created_at, x.id LIMIT @limit OFFSET @offset`,
            { ...params, limit, offset },
          )
          .map((row) => parseJsonColumns(row, ['brief'])),
      ),
    );
  });

  // FW-C-039: project writes, CLI token only. FW-C-087: a project's labels and brief may also come from the
  // paired browser (Settings), like the Supervisor controls; making a project stays with the CLI.
  const projectWrite = async (
    req: IncomingMessage,
    act: (c: ProjectControls, body: Row) => unknown,
    fromBrowser = false,
  ) => {
    const c = deps.projects;
    if (!c) throw new ApiError(501, 'not_implemented', 'this fwd does not host project writes');
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth' && !(fromBrowser && p?.kind === 'session'))
      throw new ApiError(403, 'forbidden', 'projects are changed with the CLI token, not a browser session');
    const body = await readJsonBody(req);
    let data: unknown;
    try {
      data = act(c, body);
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (code === 'ALREADY_EXISTS')
        throw new ApiError(409, 'conflict', (e as Error).message, { fw_code: code });
      throw kernelError(e);
    }
    return env(() => ({ data }));
  };
  const labelArg = (v: unknown) => (v === undefined ? undefined : v === null ? null : String(v));
  // WS-P0-021: the CLI's ledger close, run on fwd's writer. CLI token only; the probe is the row's own.
  r.post('/v1/ledger/rows/{id}/close', async ({ req, params }) => {
    const c = deps.ledger;
    if (!c) throw new ApiError(501, 'not_implemented', 'this fwd does not host ledger close');
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth')
      throw new ApiError(403, 'forbidden', 'rows are closed with the CLI token, not a browser session');
    const b = await readJsonBody(req);
    if (typeof b.merged_sha !== 'string' || typeof b.repo_dir !== 'string' || !isAbsolute(b.repo_dir))
      throw new ApiError(400, 'validation_failed', 'merged_sha and an absolute repo_dir are required');
    let data: unknown;
    try {
      data = await c.close(params.id ?? '', b.merged_sha, b.repo_dir);
    } catch (e) {
      throw kernelError(e);
    }
    return env(() => ({ data }));
  });
  // The CLI's ledger park, run on fwd's writer. CLI token only, like close.
  r.post('/v1/ledger/rows/{id}/park', async ({ req, params }) => {
    const c = deps.ledger;
    if (!c?.park) throw new ApiError(501, 'not_implemented', 'this fwd does not host ledger park');
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth')
      throw new ApiError(403, 'forbidden', 'rows are parked with the CLI token, not a browser session');
    const b = await readJsonBody(req);
    if (typeof b.reason !== 'string' || b.reason.trim().length < 3)
      throw new ApiError(400, 'validation_failed', 'a reason of at least 3 characters is required');
    let data: unknown;
    try {
      data = await c.park(params.id ?? '', b.reason);
    } catch (e) {
      throw kernelError(e);
    }
    return env(() => ({ data }));
  });
  r.post('/v1/projects', ({ req }) => projectWrite(req, (c, b) => c.add(b)));
  r.post('/v1/projects/{id}/labels', ({ req, params }) =>
    projectWrite(
      req,
      (c, b) => {
        const change: { brand?: string | null; category?: string | null } = {};
        if (b.brand !== undefined) change.brand = labelArg(b.brand) ?? null;
        if (b.category !== undefined) change.category = labelArg(b.category) ?? null;
        return c.label(params.id ?? '', change);
      },
      true,
    ),
  );
  r.post('/v1/projects/{id}/brief', ({ req, params }) =>
    projectWrite(req, (c, b) => c.brief(params.id ?? '', b), true),
  );

  r.get('/v1/projects/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>(`${PROJECT_SELECT} WHERE p.id = ?`, [params.id]);
      if (!row) throw notFound('project', params.id);
      return { data: parseJsonColumns(row, ['brief']) };
    }),
  );

  // ---- ledger -------------------------------------------------------------------------------
  r.get('/v1/ledger/rows', ({ query }) => {
    const status = oneOf(query, 'status', LEDGER_STATUSES);
    const page = pageOf(query);
    const q = query.get('q') || null;
    const params = {
      project_id: query.get('project_id') || null,
      status: status ?? null,
      milestone: query.get('milestone') || null,
      q: q === null ? null : `%${q}%`,
      qid: q === null ? null : `%${q.replace(/-/g, '')}%`,
    };
    return env(() =>
      paged(page, (limit, offset) =>
        reader
          .all<Row>(
            `SELECT * FROM ledger_rows
              WHERE (@project_id IS NULL OR project_id = @project_id)
                AND (@status IS NULL OR status = @status)
                AND (@milestone IS NULL OR wave = @milestone)
                AND (@q IS NULL OR title LIKE @q OR id LIKE @qid OR lane LIKE @q)
              ORDER BY priority, id LIMIT @limit OFFSET @offset`,
            { ...params, limit, offset },
          )
          .map(ledgerRow),
      ),
    );
  });

  r.get('/v1/ledger/rows/{id}', ({ params }) =>
    env(() => {
      const id = rowIdOf(params.id!);
      const row = reader.get<Row>('SELECT * FROM ledger_rows WHERE id = ?', [id]);
      if (!row) throw notFound('ledger row', params.id);
      const evidence = reader
        .all<Row>(
          `SELECT * FROM evidence_bundles
            WHERE id = @ebid OR subject_ref = @id
               OR subject_ref IN (SELECT id FROM work_orders WHERE ledger_row_id = @id)
               OR subject_ref IN (SELECT r.id FROM runs r JOIN work_orders w ON w.id = r.work_order_id
                                   WHERE w.ledger_row_id = @id)
            ORDER BY created_at DESC, id DESC`,
          { id, ebid: row.evidence_bundle_id ?? null },
        )
        .map(evidenceRow);
      const runs = reader
        .all<Row>(`${RUN_SELECT} WHERE w.ledger_row_id = ? ORDER BY r.queued_at DESC, r.id DESC`, [id])
        .map(runRow)
        .map((run) => ({
          id: run.id,
          work_order_id: run.work_order_id,
          agent_id: run.agent_id,
          attempt: run.attempt,
          adapter_name: run.adapter_name,
          adapter_vendor: run.adapter_vendor,
          status: run.status,
          failure_class: run.failure_class,
          branch: run.branch,
          cost_usd: run.cost_usd,
          queued_at: run.queued_at,
          started_at: run.started_at,
          ended_at: run.ended_at,
          row_code: run.row_code,
          last_heartbeat_at: run.last_heartbeat_at,
          sandbox_level: run.sandbox_level,
        }));
      // Recent events that name this row in their payload (newest first).
      const events = reader
        .all<Row>(
          `SELECT * FROM events
            WHERE json_extract(payload, '$.ledger_row_id') = @id OR json_extract(payload, '$.row_id') = @id
            ORDER BY seq DESC LIMIT 50`,
          { id },
        )
        .map((e) => parseJsonColumns(e, JSON_COLUMNS.events));
      const lastRunId = (runs[0]?.id as string | undefined) ?? null;
      return { data: { ...ledgerRow(row), last_run_id: lastRunId, evidence, runs, events } };
    }),
  );

  // ---- runs ---------------------------------------------------------------------------------
  // The CLI hands a run to fwd: the pipeline runs in the daemon (which holds the writer) and the
  // answer is the run report once the run has ended. CLI token only, never a browser session.
  r.post('/v1/runs', async ({ req, res }) => {
    const runs = deps.runs;
    if (!runs) throw new ApiError(501, 'not_implemented', 'this fwd does not host runs');
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth')
      throw new ApiError(403, 'forbidden', 'runs are started with the CLI token, not a browser session');
    if (runs.host.stopping) throw new ApiError(503, 'unavailable', 'fwd is stopping; no new runs');
    const body = runStartBody(await readJsonBody(req));
    try {
      await runs.host.track(async (signal) => {
        let status = 200;
        let out: unknown;
        try {
          const report = await runs.start(body, signal);
          out = envelope(reader, () => ({ data: report }));
        } catch (e) {
          const err = kernelError(e);
          status = err.status;
          out = { error: { code: err.code, message: err.message, details: err.details } };
        }
        // Tracked until the answer is flushed, so a stopping fwd still tells the CLI how it ended.
        await sendJsonFlushed(res, status, out);
      });
    } catch (e) {
      if (e instanceof RunHostStoppingError) throw new ApiError(503, 'unavailable', e.message);
      throw e;
    }
    return undefined;
  });

  r.get('/v1/runs', ({ query }) => {
    const status = oneOf(query, 'status', RUN_STATUSES);
    const rowId = query.get('row_id');
    const page = pageOf(query);
    return env(() =>
      paged(page, (limit, offset) =>
        reader
          .all<Row>(
            `${RUN_SELECT}
              WHERE (@status IS NULL OR r.status = @status)
                AND (@row_id IS NULL OR w.ledger_row_id = @row_id)
                AND (@project_id IS NULL OR r.project_id = @project_id)
              ORDER BY r.queued_at DESC, r.id DESC LIMIT @limit OFFSET @offset`,
            {
              status: status ?? null,
              row_id: rowId ? rowIdOf(rowId) : null,
              project_id: query.get('project_id') || null,
              limit,
              offset,
            },
          )
          .map(runRow),
      ),
    );
  });

  r.get('/v1/runs/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>(`${RUN_SELECT} WHERE r.id = ?`, [params.id]);
      if (!row) throw notFound('run', params.id);
      const artifacts = reader
        .all<Row>(
          `SELECT kind, ref, sha, claimed_by_agent, verified_by_kernel, verified_at, created_at
             FROM run_artifacts WHERE run_id = ? ORDER BY created_at, id`,
          [params.id],
        )
        .map((a) => ({
          ...a,
          claimed_by_agent: a.claimed_by_agent === 1,
          verified_by_kernel: a.verified_by_kernel === 1,
        }));
      return { data: { ...runRow(row), artifacts } };
    }),
  );

  r.get('/v1/runs/{id}/steps', ({ params, query }) => {
    const page = pageOf(query);
    return env(() => {
      if (!reader.get('SELECT 1 FROM runs WHERE id = ?', [params.id])) throw notFound('run', params.id);
      return paged(page, (limit, offset) =>
        reader.all<Row>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq LIMIT ? OFFSET ?', [
          params.id,
          limit,
          offset,
        ]),
      );
    });
  });

  // ---- evidence -----------------------------------------------------------------------------
  r.get('/v1/evidence-bundles/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>('SELECT * FROM evidence_bundles WHERE id = ?', [params.id]);
      if (!row) throw notFound('evidence bundle', params.id);
      return { data: evidenceRow(row) };
    }),
  );

  r.get('/v1/evidence-bundles/{id}/diff', ({ params, res }) => {
    const as_of = new Date().toISOString();
    const head = headSeq(reader);
    const row = reader.get<Row>('SELECT * FROM evidence_bundles WHERE id = ?', [params.id]);
    if (!row) throw notFound('evidence bundle', params.id);
    const ref = storedDiff(deps.fwHome, parseJsonColumns(row, JSON_COLUMNS.evidence_bundles));
    if (!ref) throw notFound('stored diff for evidence bundle', params.id);
    for (const path of ref.candidates) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      const got = sha256Hex(bytes);
      if (got !== ref.hash) {
        throw new ApiError(500, 'internal', 'stored diff bytes do not match the bundle diff hash', {
          expected: ref.hash,
          got,
        });
      }
      res.writeHead(200, {
        'content-type': 'text/x-diff',
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'x-fw-as-of': as_of,
        'x-fw-head-seq': String(head),
        'x-fw-sha256': got,
      });
      res.end(bytes);
      return undefined;
    }
    throw notFound('stored diff for evidence bundle', params.id);
  });

  // ---- events -------------------------------------------------------------------------------
  r.get('/v1/events', ({ query }) => {
    const after = nonNegInt(query, 'after_seq') ?? 0;
    const cursor = query.get('cursor');
    if (cursor !== null && cursor !== '' && !/^\d+$/.test(cursor)) {
      throw invalid('cursor is not one this daemon issued');
    }
    const from = cursor ? Math.max(after, Number(cursor)) : after;
    const limit = limitOf(query);
    const type = query.get('type') || null;
    const prefix = type?.endsWith('*') ? type.slice(0, -1) : null;
    return env(() => {
      const rows = reader.all<Row>(
        `SELECT * FROM events WHERE seq > @from
            AND (@type IS NULL OR type = @type) AND (@prefix IS NULL OR substr(type, 1, length(@prefix)) = @prefix)
            AND (@run_id IS NULL OR run_id = @run_id)
          ORDER BY seq LIMIT @limit`,
        {
          from,
          type: prefix ? null : type,
          prefix,
          run_id: query.get('run_id') || null,
          limit: limit + 1,
        },
      );
      const more = rows.length > limit;
      const data = (more ? rows.slice(0, limit) : rows).map((e) => parseJsonColumns(e, JSON_COLUMNS.events));
      return { data, next_cursor: more ? String(data[data.length - 1]!.seq) : null };
    });
  });

  r.get('/v1/events/stream', ({ req, res, query }) => {
    streamEvents(req, res, query, deps);
    return undefined;
  });

  // ---- spend and budgets ---------------------------------------------------------------------
  r.get('/v1/spend', ({ query }) => {
    const by = oneOf(query, 'group_by', API_SPEND_GROUPS) ?? 'project';
    const from = isoParam(query, 'from') ?? null;
    const to = isoParam(query, 'to') ?? null;
    const page = pageOf(query);
    return env(() => paged(page, (limit, offset) => spendRollup(reader, { by, from, to, limit, offset })));
  });

  r.get('/v1/budgets', ({ query }) => {
    const page = pageOf(query);
    return env(() =>
      paged(page, (limit, offset) =>
        reader
          .all<Row>(
            `SELECT b.*, u.spent_usd AS spent_usd FROM budgets b JOIN budget_usage u ON u.budget_id = b.id
              ORDER BY b.scope_kind, b.scope_id, b.period LIMIT ? OFFSET ?`,
            [limit, offset],
          )
          .map((row) => parseJsonColumns(row, JSON_COLUMNS.budgets)),
      ),
    );
  });

  // ---- decision cards and approvals ----------------------------------------------------------
  r.get('/v1/decision-cards', ({ query }) => {
    const status = oneOf(query, 'status', CARD_STATUSES);
    const page = pageOf(query);
    return env(() =>
      paged(page, (limit, offset) =>
        reader
          .all<Row>(
            `${CARD_SELECT} WHERE (@status IS NULL OR c.status = @status)
              ORDER BY ${URGENCY_ORDER}, c.deadline_at IS NULL, c.deadline_at, c.created_at, c.id
              LIMIT @limit OFFSET @offset`,
            { status: status ?? null, limit, offset },
          )
          .map(cardRow),
      ),
    );
  });

  r.get('/v1/decision-cards/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>(`${CARD_SELECT} WHERE c.id = ?`, [params.id]);
      if (!row) throw notFound('decision card', params.id);
      const card = cardRow(row);
      const approval =
        typeof card.approval_id === 'string'
          ? (reader.get<Row>(
              'SELECT payload_hash, head_sha, expires_at, status FROM approvals WHERE id = ?',
              [card.approval_id],
            ) ?? null)
          : null;
      const body = (card.body ?? {}) as Row;
      const runId = ((body.source ?? {}) as Row).run_id;
      const prRow =
        typeof runId === 'string'
          ? reader.get<{ ref: string; sha: string | null; verified_at: string | null; created_at: string }>(
              `SELECT ref, sha, verified_at, created_at FROM run_artifacts
                WHERE run_id = ? AND kind = 'pull_request' ORDER BY id DESC LIMIT 1`,
              [runId],
            )
          : undefined;
      const pr = prRow
        ? {
            url: prRow.ref,
            number: Number(/\/pull\/(\d+)/.exec(prRow.ref)?.[1] ?? Number.NaN) || null,
            current_head_sha: prRow.sha,
            head_observed_at: prRow.verified_at ?? prRow.created_at,
          }
        : null;
      let files: unknown = null;
      if (typeof card.evidence_bundle_id === 'string') {
        const eb = reader.get<{ files: string | null }>(
          "SELECT COALESCE(json_extract(body, '$.diff.files'), json_extract(body, '$.blast_radius.affected')) AS files FROM evidence_bundles WHERE id = ?",
          [card.evidence_bundle_id],
        );
        // body.diff.files: [{path, added, removed}]; an older bundle has only the paths.
        if (eb?.files)
          files = (JSON.parse(eb.files) as unknown[]).map((f) =>
            typeof f === 'string' ? { path: f, added: null, removed: null } : f,
          );
      }
      // merge_slot and policy are null until C1 (FW-C-011 merge slot, FW-C-010 approval service).
      return { data: { ...card, approval, pr, merge_slot: null, policy: null, files } };
    }),
  );

  r.get('/v1/approvals/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>('SELECT * FROM approvals WHERE id = ?', [params.id]);
      if (!row) throw notFound('approval', params.id);
      return { data: parseJsonColumns(row, JSON_COLUMNS.approvals) };
    }),
  );

  // ---- write routes that later rows add ----------------------------------------------------
  for (const [method, path, row, milestone] of NOT_IMPLEMENTED) {
    r.add(method, path, () => {
      throw new ApiError(501, 'not_implemented', `${method} ${path} is not implemented in C0`, {
        row,
        milestone,
      });
    });
  }

  return r;
}
