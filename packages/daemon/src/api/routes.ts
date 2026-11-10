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
import * as localSaturation from '../flows/local-saturation.ts';
import * as neighborhoodActivation from '../flows/neighborhood-activation.ts';
import * as naAdmin from '../flows/neighborhood-admin.ts';
import { SupervisorError, supervisorView } from '../overseer/index.ts';
import { type RunHost, RunHostStoppingError } from '../run-host.ts';
import { isInside, RUN_ID_RE } from '../runtime/paths.ts';
import { setupReport } from '../setup/index.ts';
import { spendRollup } from '../spend.ts';
import { rowIdOf } from './codes.ts';
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
  /** FW-C-038: fire the flow's stream by hand; the Supervisor decides it like any fire. */
  runFlow?(key: string): Promise<{ fire_id: string; outcome: string; reason?: string }>;
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
  r.get('/v1/flows/{key}', ({ params }) =>
    env(() => {
      const view = FLOWS[params.key ?? '']?.(deps.repoRoot, deps.fwHome, new Date());
      if (!view) throw notFound('flow', params.key);
      return { data: view };
    }),
  );
  addFlowAdminRoutes(r, deps);

  // ---- supervisor (FW-C-033) ----------------------------------------------------------------
  r.get('/v1/supervisor', () =>
    env(() => ({ data: supervisorView({ reader, repoRoot: deps.repoRoot, fwHome: deps.fwHome }) })),
  );
  // The Owner's controls: CLI token only, never a browser session.
  const ownerControl = (req: object, act: (c: SupervisorControls) => { changed: boolean }) => {
    const c = deps.supervisor;
    if (!c) throw new ApiError(501, 'not_implemented', 'this fwd does not host the Supervisor controls');
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth')
      throw new ApiError(
        403,
        'forbidden',
        'the Supervisor is controlled with the CLI token, not a browser session',
      );
    try {
      const out = act(c);
      return env(() => ({
        data: {
          changed: out.changed,
          ...supervisorView({ reader, repoRoot: deps.repoRoot, fwHome: deps.fwHome }),
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
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth')
      throw new ApiError(
        403,
        'forbidden',
        'the Supervisor is controlled with the CLI token, not a browser session',
      );
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
        reader.all<Row>(
          `SELECT * FROM (${PROJECT_SELECT}) x
            WHERE (@brand IS NULL OR lower(trim(x.brand)) = lower(trim(@brand)))
              AND (@category IS NULL OR x.category = lower(@category))
            ORDER BY x.created_at, x.id LIMIT @limit OFFSET @offset`,
          { ...params, limit, offset },
        ),
      ),
    );
  });

  // FW-C-039: project writes, CLI token only (like the Supervisor controls).
  const projectWrite = async (req: IncomingMessage, act: (c: ProjectControls, body: Row) => unknown) => {
    const c = deps.projects;
    if (!c) throw new ApiError(501, 'not_implemented', 'this fwd does not host project writes');
    const p = principalOf.get(req);
    if (p?.kind !== 'cli' && p?.kind !== 'dev_no_auth')
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
  r.post('/v1/projects', ({ req }) => projectWrite(req, (c, b) => c.add(b)));
  r.post('/v1/projects/{id}/labels', ({ req, params }) =>
    projectWrite(req, (c, b) => {
      const change: { brand?: string | null; category?: string | null } = {};
      if (b.brand !== undefined) change.brand = labelArg(b.brand) ?? null;
      if (b.category !== undefined) change.category = labelArg(b.category) ?? null;
      return c.label(params.id ?? '', change);
    }),
  );
  r.post('/v1/projects/{id}/brief', ({ req, params }) =>
    projectWrite(req, (c, b) => c.brief(params.id ?? '', b)),
  );

  r.get('/v1/projects/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>(`${PROJECT_SELECT} WHERE p.id = ?`, [params.id]);
      if (!row) throw notFound('project', params.id);
      return { data: row };
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
