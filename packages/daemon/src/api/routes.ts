// Route table for /v1 (docs/api/LOCAL-API-V1.md). Read routes query the database through a
// read-only Reader; the only C0 write is POST /v1/pair. Later write routes answer 501 with the row
// that adds them. No business logic lives here.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type Reader, sha256Hex } from '@fw/eventlog';
import type { PairingStore, Principal } from '../auth.ts';
import { isInside, RUN_ID_RE } from '../runtime/paths.ts';
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
} from './http.ts';
import { Router } from './router.ts';
import {
  CARD_SELECT,
  cardRow,
  evidenceRow,
  JSON_COLUMNS,
  ledgerRow,
  parseJsonColumns,
  RUN_SELECT,
  runRow,
  URGENCY_ORDER,
} from './rows.ts';
import { streamEvents } from './sse.ts';
import { type ChainStatus, statusOf } from './status.ts';

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
const SPEND_GROUPS = { project: 'project_id', agent: 'agent_id', vendor: 'vendor' } as const;

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

/** The diff a bundle points at: `body.diff.path` or `intent_payload.rendered_ref` under FW_HOME, else runs/<run>/diff.patch. */
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
  if (typeof diff.path === 'string') {
    candidates.push(isAbsolute(diff.path) ? diff.path : resolve(fwHome, diff.path));
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
    return env(() =>
      paged(page, (limit, offset) =>
        reader.all<Row>('SELECT * FROM projects ORDER BY created_at, id LIMIT ? OFFSET ?', [limit, offset]),
      ),
    );
  });

  r.get('/v1/projects/{id}', ({ params }) =>
    env(() => {
      const row = reader.get<Row>('SELECT * FROM projects WHERE id = ?', [params.id]);
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
      return { data: { ...ledgerRow(row), evidence, runs } };
    }),
  );

  // ---- runs ---------------------------------------------------------------------------------
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
      return { data: runRow(row) };
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
    const group = oneOf(query, 'group_by', ['project', 'agent', 'vendor'] as const) ?? 'project';
    const col = SPEND_GROUPS[group];
    const from = isoParam(query, 'from') ?? null;
    const to = isoParam(query, 'to') ?? null;
    const page = pageOf(query);
    return env(() =>
      paged(page, (limit, offset) =>
        reader.all<Row>(
          `SELECT ${col} AS ${col}, ROUND(SUM(usd), 6) AS usd, SUM(tokens_in) AS tokens_in,
                  SUM(tokens_out) AS tokens_out, SUM(tokens_cached) AS tokens_cached, COUNT(*) AS entries,
                  MIN(ts) AS first_ts, MAX(ts) AS last_ts
             FROM spend_entries
            WHERE (@from IS NULL OR ts >= @from) AND (@to IS NULL OR ts < @to)
            GROUP BY ${col} ORDER BY usd DESC, ${col} LIMIT @limit OFFSET @offset`,
          { from, to, limit, offset },
        ),
      ),
    );
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
        if (eb?.files) files = JSON.parse(eb.files);
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
