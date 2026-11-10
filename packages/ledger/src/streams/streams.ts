// Streams: the stream object model stored in the ledger database (the streams table of
// schema.core.sql, one stream-definition.json document per row). A stream is added only when its
// definition is valid, carries a budget with at least one cap, and, when its default tier is above
// L2, names an Owner approval recorded for it. Every added stream writes one stream.created event.
import type { StreamDefinition } from '@fw/contracts';
import { validate } from '@fw/contracts';
import { canonicalJson, type Reader, sha256Hex, type Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from '../bootstrap.ts';
import { LedgerError, surfaceDbRefusal } from '../errors.ts';

/** The highest default tier a stream may have without a recorded Owner approval. */
export const UNAPPROVED_TIER_MAX = 'L2';

export interface StreamView {
  id: string;
  project_id: string;
  key: string;
  name: string;
  template: string;
  status: string;
  default_tier: string;
  version: number;
  wip_limit: number;
  trigger: string;
  budget: StreamDefinition['budget'];
  definition_hash: string;
  last_fired_at: string | null;
  created_at: string;
}

export interface StreamAddReport {
  stream: StreamView;
  approval_id: string | null;
  event_seq: number;
}

const tierRank = (r: Reader, tier: string): number | undefined =>
  r.get<{ rank: number }>('SELECT rank FROM autonomy_tiers WHERE tier = ?', [tier])?.rank;

/** Throws unless the definition has a budget with at least one cap. Checked before the contract so
 * the refusal names the budget, not a schema path. */
function requireBudget(def: Record<string, unknown>): void {
  const budget = def.budget as { caps?: unknown } | undefined;
  if (!budget || typeof budget !== 'object')
    throw new LedgerError('INVALID_DEFINITION', 'a stream without a budget is refused: add budget.caps');
  const caps = budget.caps;
  if (!caps || typeof caps !== 'object' || Object.keys(caps).length === 0)
    throw new LedgerError(
      'INVALID_DEFINITION',
      'a stream budget with no caps is no budget: budget.caps needs at least one cap',
    );
}

/** Throws unless approvalId names an approved Owner approval for this stream at or above its tier. */
function requireApproval(r: Reader, def: StreamDefinition, approvalId: string | undefined): void {
  const want = tierRank(r, def.default_tier);
  const max = tierRank(r, UNAPPROVED_TIER_MAX);
  if (want === undefined || max === undefined || want <= max) return;
  if (!approvalId)
    throw new LedgerError(
      'APPROVAL_REQUIRED',
      `default_tier ${def.default_tier} is above ${UNAPPROVED_TIER_MAX}: it needs a recorded Owner approval (--approval <apr_id>)`,
      { stream_id: def.id, default_tier: def.default_tier },
    );
  const apr = r.get<{ status: string; subject_kind: string; subject_ref: string; tier: string }>(
    'SELECT status, subject_kind, subject_ref, tier FROM approvals WHERE id = ?',
    [approvalId],
  );
  const ok =
    apr &&
    apr.status === 'approved' &&
    apr.subject_kind === 'stream' &&
    apr.subject_ref === def.id &&
    (tierRank(r, apr.tier) ?? -1) >= want;
  if (!ok)
    throw new LedgerError(
      'APPROVAL_REQUIRED',
      `approval ${approvalId} is not a recorded Owner approval of stream ${def.id} at ${def.default_tier} or above`,
      { stream_id: def.id, default_tier: def.default_tier, approval_id: approvalId },
    );
}

type StreamDbRow = Omit<StreamView, 'trigger' | 'budget'> & { definition: string };

function toView(row: StreamDbRow): StreamView {
  const def = JSON.parse(row.definition) as StreamDefinition;
  const { definition: _definition, ...rest } = row;
  return { ...rest, trigger: def.trigger.type, budget: def.budget };
}

const SELECT = `SELECT id, project_id, key, name, template, status, default_tier, version, wip_limit,
  definition, definition_hash, last_fired_at, created_at FROM streams`;

/** Every stream, ordered by project and key. */
export function listStreams(r: Reader, opts: { projectId?: string } = {}): StreamView[] {
  const rows = opts.projectId
    ? r.all<StreamDbRow>(`${SELECT} WHERE project_id = ? ORDER BY project_id, key`, [opts.projectId])
    : r.all<StreamDbRow>(`${SELECT} ORDER BY project_id, key`);
  return rows.map(toView);
}

/** Validates and stores one stream definition. Nothing is written when any check refuses it. */
export function addStream(
  w: Writer,
  input: unknown,
  opts: { approvalId?: string; actor?: Actor } = {},
): StreamAddReport {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new LedgerError('INVALID_DEFINITION', 'a stream definition is a JSON object');
  requireBudget(input as Record<string, unknown>);
  const check = validate('stream-definition', input);
  if (!check.ok)
    throw new LedgerError(
      'INVALID_DEFINITION',
      `not a valid stream definition: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      { errors: check.errors },
    );
  const def = input as StreamDefinition;
  return w.transaction((tx) => {
    if (!tx.get('SELECT 1 FROM projects WHERE id = ?', [def.project_id]))
      throw new LedgerError('NOT_FOUND', `project ${def.project_id} is not in the ledger`);
    if (
      tx.get('SELECT 1 FROM streams WHERE id = ? OR (project_id = ? AND key = ?)', [
        def.id,
        def.project_id,
        def.key,
      ])
    )
      throw new LedgerError(
        'ALREADY_EXISTS',
        `stream ${def.id} or key ${def.key} already exists in this project`,
      );
    requireApproval(tx, def, opts.approvalId);
    const actor = opts.actor ?? ownerActor(tx);
    const text = canonicalJson(def);
    const hash = sha256Hex(text);
    surfaceDbRefusal(() =>
      tx.run(
        `INSERT INTO streams(id, project_id, key, name, template, definition, definition_hash, version, status, default_tier, wip_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          def.id,
          def.project_id,
          def.key,
          def.name,
          def.template,
          text,
          hash,
          def.version,
          def.enabled ? 'active' : 'draft',
          def.default_tier,
          def.wip_limit ?? 2,
        ],
      ),
    );
    const ev = tx.appendEvent({
      type: 'stream.created',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: def.project_id,
      stream_id: def.id,
      idempotency_key: def.id,
      payload: {
        stream_id: def.id,
        template: def.template,
        definition_hash: hash,
        ...(opts.approvalId ? { approval_id: opts.approvalId } : {}),
      },
    });
    const stored = tx.get<StreamDbRow>(`${SELECT} WHERE id = ?`, [def.id]);
    return { stream: toView(stored!), approval_id: opts.approvalId ?? null, event_seq: ev.seq };
  });
}

/**
 * FW-C-063: moves a stream's cron. The stored definition gets the new cron and timezone, version + 1 and
 * a new definition_hash, and one stream.updated event names the change. A cron already set changes
 * nothing. The caller reloads the scheduler.
 */
export function setStreamCron(
  w: Writer,
  streamId: string,
  cron: string,
  opts: { timezone?: string; actor?: Actor } = {},
): { changed: boolean; version: number } {
  return w.transaction((tx) => {
    const row = tx.get<{ definition: string; version: number; project_id: string }>(
      'SELECT definition, version, project_id FROM streams WHERE id = ?',
      [streamId],
    );
    if (!row) throw new LedgerError('NOT_FOUND', `stream ${streamId} is not in the ledger`);
    const def = JSON.parse(row.definition) as StreamDefinition & { trigger: Record<string, unknown> };
    if (def.trigger.type !== 'cron')
      throw new LedgerError('INVALID_DEFINITION', `stream ${streamId} is not fired by a cron`);
    const timezone = opts.timezone ?? (def.trigger.timezone as string | undefined);
    if (def.trigger.cron === cron && def.trigger.timezone === timezone)
      return { changed: false, version: row.version };
    const version = row.version + 1;
    const next = {
      ...def,
      version,
      trigger: { ...def.trigger, cron, ...(timezone ? { timezone } : {}) },
    } as StreamDefinition;
    const check = validate('stream-definition', next);
    if (!check.ok)
      throw new LedgerError(
        'INVALID_DEFINITION',
        `not a valid stream definition: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    const text = canonicalJson(next);
    const hash = sha256Hex(text);
    const actor = opts.actor ?? ownerActor(tx);
    tx.run(
      `UPDATE streams SET definition = ?, definition_hash = ?, version = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [text, hash, version, streamId],
    );
    tx.appendEvent({
      type: 'stream.updated',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: row.project_id,
      stream_id: streamId,
      idempotency_key: `${streamId}:${version}`,
      payload: { stream_id: streamId, version, definition_hash: hash, changed_by: actor.id },
    });
    return { changed: true, version };
  });
}
