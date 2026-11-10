// Decision items: the Owner's decision inbox, stored as decision cards (the decision_cards table of
// schema.core.sql, one decision-card.json body per row). The item types are the five card variants
// and nothing else. Every item carries its default action (default_on_timeout); an approve item's
// default is always deny. Past its deadline an open item expires: the default is recorded as applied
// in one decision_card.expired event, and the pending approval behind an approve item expires too, so
// it can no longer be granted. Items name no stream in the card contract, so an item's stream is the
// stream_id of its decision_card.created event.
import type { DecisionCard } from '@fw/contracts';
import { validate } from '@fw/contracts';
import { newId, nowIso, type Reader, type Writer } from '@fw/eventlog';
import type { Actor } from '../bootstrap.ts';
import { LedgerError, surfaceDbRefusal } from '../errors.ts';

/** The closed set of decision item types: exactly the decision-card.json variants. */
export const DECISION_VARIANTS = Object.freeze(['approve', 'choose', 'answer', 'review', 'unblock'] as const);
export type DecisionVariant = (typeof DECISION_VARIANTS)[number];
// Compile-time proof that the list and the generated contract type are the same union.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
void (true satisfies Same<DecisionVariant, DecisionCard['variant']>);

export const DECISION_STATUSES = Object.freeze([
  'open',
  'snoozed',
  'answered',
  'expired',
  'withdrawn',
] as const);
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface CreateDecisionItemInput {
  /** Project id (prj_...) or slug; stored as project_id. */
  project?: string;
  /** Stream id (stm_...) or key; recorded as the stream_id of decision_card.created. */
  stream?: string;
  variant: DecisionVariant;
  /** Defaults to the ask, cut to 100 characters. */
  title?: string;
  ask: string;
  /** Defaults to 'today'. */
  urgency?: DecisionCard['urgency'];
  /** When the default applies; stored as deadline_at. No deadline: the item never expires. */
  deadline?: string | Date;
  /** What happens if nobody answers. Required; 'deny' for approve. */
  default_on_timeout: string;
  /** choose: the id of the recommended option; stored as recommended_option. */
  recommended?: string;
  /** Any other decision-card.json field of the variant (options, payload_preview, question, ...). */
  [field: string]: unknown;
}

export interface DecisionItem {
  card_id: string;
  variant: DecisionVariant;
  project_id: string | null;
  stream_id: string | null;
  title: string;
  ask: string;
  urgency: DecisionCard['urgency'];
  deadline_at: string | null;
  default_on_timeout: string;
  status: DecisionStatus;
  /** The default that was applied, once the item has expired. */
  default_applied: string | null;
  approval_id: string | null;
  evidence_bundle_id: string | null;
  answer: unknown;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
  body: DecisionCard;
}

export interface ExpiredDecisionItem {
  card_id: string;
  variant: DecisionVariant;
  default_applied: string;
  approval_id: string | null;
}

export interface DecisionOptions {
  /** Who creates the item. Default: the system actor fwd.decisions. */
  actor?: Actor;
  /** Clock override for tests. */
  now?: () => Date;
}

const SYSTEM = { kind: 'system', id: 'fwd.decisions' } as const;
const LIVE = "('open', 'snoozed')";
const SELECT = `SELECT c.id AS card_id, c.variant, c.project_id, e.stream_id, c.title, c.ask, c.urgency,
  c.deadline_at, c.default_on_timeout, c.status, c.approval_id, c.evidence_bundle_id, c.answer, c.answered_by,
  c.answered_at, c.created_at, c.body
  FROM decision_cards c LEFT JOIN events e ON e.type = 'decision_card.created' AND e.idempotency_key = c.id`;

type CardRow = Omit<DecisionItem, 'default_applied' | 'body' | 'answer'> & {
  body: string;
  answer: string | null;
};

function toItem(row: CardRow): DecisionItem {
  return {
    ...row,
    default_applied: row.status === 'expired' ? row.default_on_timeout : null,
    answer: row.answer === null ? null : JSON.parse(row.answer),
    body: JSON.parse(row.body) as DecisionCard,
  };
}

const bad = (message: string, details: Record<string, unknown> = {}) =>
  new LedgerError('BAD_ARGUMENT', message, details);

function checkVariant(v: unknown): DecisionVariant {
  if (!(DECISION_VARIANTS as readonly unknown[]).includes(v))
    throw bad(`unknown decision item type ${JSON.stringify(v)}: use one of ${DECISION_VARIANTS.join(', ')}`);
  return v as DecisionVariant;
}

function checkDefault(variant: DecisionVariant, d: unknown): string {
  if (typeof d !== 'string' || d.trim() === '')
    throw bad(
      'a decision item needs a default action: set default_on_timeout to what happens if nobody answers',
    );
  if (variant === 'approve' && d !== 'deny')
    throw bad(`the default action of an approve item is always deny, not ${JSON.stringify(d)}`);
  return d;
}

function checkDeadline(d: unknown, now: Date): string | undefined {
  if (d === undefined || d === null) return undefined;
  const t = d instanceof Date ? d : typeof d === 'string' ? new Date(d) : undefined;
  if (!t || Number.isNaN(t.getTime())) throw bad(`deadline is not a date: ${String(d)}`);
  if (t.getTime() <= now.getTime()) throw bad(`deadline ${t.toISOString()} has already passed`);
  return nowIso(t);
}

function projectId(r: Reader, ref: string): string {
  const p = r.get<{ id: string }>('SELECT id FROM projects WHERE id = ? OR slug = ?', [ref, ref]);
  if (!p) throw new LedgerError('NOT_FOUND', `project ${ref} is not in the ledger`);
  return p.id;
}

function streamId(r: Reader, ref: string, project: string | undefined): string {
  const s = r.get<{ id: string; project_id: string }>(
    'SELECT id, project_id FROM streams WHERE (id = ? OR key = ?) AND (? IS NULL OR project_id = ?) ORDER BY id LIMIT 1',
    [ref, ref, project ?? null, project ?? null],
  );
  if (!s)
    throw new LedgerError(
      'NOT_FOUND',
      `stream ${ref} is not in the ledger${project ? ` for project ${project}` : ''}`,
    );
  return s.id;
}

/**
 * Validates and stores one decision item as an open decision card, with one decision_card.created
 * event. Nothing is written when a check refuses it.
 */
export function createDecisionItem(
  w: Writer,
  input: CreateDecisionItemInput,
  opts: DecisionOptions = {},
): DecisionItem {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('a decision item is an object');
  const { project, stream, deadline, recommended, title, urgency, ...rest } = input;
  const variant = checkVariant(rest.variant);
  const dflt = checkDefault(variant, rest.default_on_timeout);
  const now = opts.now ? opts.now() : new Date();
  const deadline_at = checkDeadline(deadline, now);
  if (variant === 'choose' && recommended !== undefined) {
    const ids = Array.isArray(rest.options) ? rest.options.map((o) => (o as { id?: unknown })?.id) : [];
    if (!ids.includes(recommended))
      throw bad(`recommended ${JSON.stringify(recommended)} is not the id of one of the options`);
  }
  return w.transaction((tx) => {
    const project_id = project === undefined ? undefined : projectId(tx, project);
    const stream_id = stream === undefined ? undefined : streamId(tx, stream, project_id);
    const ask = typeof rest.ask === 'string' ? rest.ask : '';
    const body: Record<string, unknown> = {
      ...rest,
      id: newId('dcd', now.getTime()),
      variant,
      ...(project_id ? { project_id } : {}),
      title: title ?? (ask.length > 100 ? `${ask.slice(0, 99)}…` : ask),
      urgency: urgency ?? 'today',
      ...(deadline_at ? { deadline_at } : {}),
      default_on_timeout: dflt,
      ...(recommended !== undefined ? { recommended_option: recommended } : {}),
      created_at: nowIso(now),
    };
    const check = validate('decision-card', body);
    if (!check.ok)
      throw new LedgerError(
        'INVALID_DEFINITION',
        `not a valid ${variant} decision item: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
        { errors: check.errors },
      );
    const card = body as DecisionCard;
    surfaceDbRefusal(() =>
      tx.run(
        `INSERT INTO decision_cards(id, variant, project_id, title, ask, urgency, deadline_at, default_on_timeout,
           approval_id, evidence_bundle_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          card.id,
          variant,
          project_id ?? null,
          card.title,
          card.ask,
          card.urgency,
          deadline_at ?? null,
          dflt,
          (body.approval_id as string | undefined) ?? null,
          card.evidence_bundle_id ?? null,
          JSON.stringify(card),
          card.created_at,
        ],
      ),
    );
    const actor = opts.actor ?? SYSTEM;
    tx.appendEvent({
      type: 'decision_card.created',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: project_id ?? null,
      stream_id: stream_id ?? null,
      idempotency_key: card.id,
      payload: {
        card_id: card.id,
        variant,
        urgency: card.urgency,
        deadline_at: deadline_at ?? null,
        default_on_timeout: dflt,
        ...(card.source ? { source: card.source } : {}),
      },
    });
    return toItem(tx.get<CardRow>(`${SELECT} WHERE c.id = ?`, [card.id])!);
  });
}

/** Decision items, oldest first, filtered by project (id or slug), stream (id or key) and status. */
export function listDecisionItems(
  r: Reader,
  filter: { project?: string; stream?: string; status?: DecisionStatus } = {},
): DecisionItem[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.status !== undefined) {
    if (!(DECISION_STATUSES as readonly string[]).includes(filter.status))
      throw bad(
        `unknown decision item status ${JSON.stringify(filter.status)}: use one of ${DECISION_STATUSES.join(', ')}`,
      );
    where.push('c.status = ?');
    params.push(filter.status);
  }
  if (filter.project !== undefined) {
    where.push('c.project_id IN (SELECT id FROM projects WHERE id = ? OR slug = ?)');
    params.push(filter.project, filter.project);
  }
  if (filter.stream !== undefined) {
    where.push('e.stream_id IN (SELECT id FROM streams WHERE id = ? OR key = ?)');
    params.push(filter.stream, filter.stream);
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.created_at, c.id`;
  return r.all<CardRow>(sql, params).map(toItem);
}

/**
 * Applies the default of every open or snoozed item whose deadline has passed: the card becomes
 * expired with one decision_card.expired { card_id, default_applied }, and the pending approval
 * behind an approve item expires (one approval.expired, default deny). Running it again changes
 * nothing.
 */
export function expireDecisionItems(
  w: Writer,
  opts: Pick<DecisionOptions, 'now'> = {},
): ExpiredDecisionItem[] {
  return w.transaction((tx) => {
    const at = nowIso(opts.now ? opts.now() : new Date());
    const due = tx.all<CardRow>(
      `${SELECT} WHERE c.status IN ${LIVE} AND c.deadline_at IS NOT NULL AND c.deadline_at <= ? ORDER BY c.deadline_at, c.id`,
      [at],
    );
    return due.map((c) => {
      tx.run(`UPDATE decision_cards SET status = 'expired' WHERE id = ? AND status IN ${LIVE}`, [c.card_id]);
      const scope = {
        actor_kind: SYSTEM.kind,
        actor_id: SYSTEM.id,
        project_id: c.project_id,
        stream_id: c.stream_id,
      };
      if (c.variant === 'approve' && c.approval_id) {
        const n = tx.run("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'", [
          c.approval_id,
        ]);
        if (n.changes > 0)
          tx.appendEvent({
            ...scope,
            type: 'approval.expired',
            idempotency_key: `${c.approval_id}:expired`,
            payload: { approval_id: c.approval_id, default_applied: 'deny' },
          });
      }
      tx.appendEvent({
        ...scope,
        type: 'decision_card.expired',
        idempotency_key: `${c.card_id}:expired`,
        payload: { card_id: c.card_id, default_applied: c.default_on_timeout },
      });
      return {
        card_id: c.card_id,
        variant: c.variant,
        default_applied: c.default_on_timeout,
        approval_id: c.approval_id,
      };
    });
  });
}
