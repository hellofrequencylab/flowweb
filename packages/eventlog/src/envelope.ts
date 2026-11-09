// The hashed form of an event: the event-envelope contract (contracts-core/json-schema/event-envelope.json).
//   payload_hash = sha256(canonical_json(payload))
//   hash         = sha256(prev_hash + "\n" + canonical_json(envelope without hash))
// Canonical JSON is RFC 8785. Optional fields that are null are left out of the envelope, because the
// contract types them as strings (null is not a valid value); this reproduces the reference hash in
// contracts-core/examples/20-event-envelope.json.
import type { EventEnvelope } from '@fw/contracts';
import type { ActorKind } from './types.ts';
import { canonicalJson, sha256Hex } from './util.ts';

export const GENESIS_HASH = '0'.repeat(64);

/** One row of the events table, as stored. */
export interface EventRow {
  seq: number;
  id: string;
  ts: string;
  type: string;
  version: number;
  actor_kind: ActorKind;
  actor_id: string;
  project_id: string | null;
  stream_id: string | null;
  work_order_id: string | null;
  run_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  payload: string;
  payload_hash: string;
  prev_hash: string;
  hash: string;
}

export const EVENT_COLUMNS =
  'seq,id,ts,type,version,actor_kind,actor_id,project_id,stream_id,work_order_id,run_id,' +
  'correlation_id,causation_id,idempotency_key,payload,payload_hash,prev_hash,hash';

const OPTIONAL = ['project_id', 'stream_id', 'work_order_id', 'run_id'] as const;

/** Builds the contract envelope (without hash) from a row whose payload is already parsed. */
export function envelopeOf(
  row: Omit<EventRow, 'payload' | 'hash'>,
  payload: Record<string, unknown>,
): Omit<EventEnvelope, 'hash'> {
  const env: Record<string, unknown> = {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    type: row.type,
    version: row.version,
    actor: { kind: row.actor_kind, id: row.actor_id },
  };
  for (const k of OPTIONAL) if (row[k] !== null && row[k] !== undefined) env[k] = row[k];
  env.correlation_id = row.correlation_id;
  if (row.causation_id !== null && row.causation_id !== undefined) env.causation_id = row.causation_id;
  env.idempotency_key = row.idempotency_key;
  env.payload = payload;
  env.payload_hash = row.payload_hash;
  env.prev_hash = row.prev_hash;
  return env as Omit<EventEnvelope, 'hash'>;
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** hash = sha256(prev_hash + "\n" + canonical_json(envelope without hash)). */
export function envelopeHash(envelope: Omit<EventEnvelope, 'hash'> | Record<string, unknown>): string {
  const { hash: _ignored, ...rest } = envelope as Record<string, unknown>;
  return sha256Hex(`${String(rest.prev_hash)}\n${canonicalJson(rest)}`);
}

export type RowCheck = { ok: true } | { ok: false; reason: string };

/** Recomputes payload_hash and hash for one stored row and checks its link to the previous hash. */
export function checkRow(row: EventRow, expectedPrev: string, expectedSeq: number): RowCheck {
  if (row.seq !== expectedSeq)
    return { ok: false, reason: `seq gap: expected ${expectedSeq}, found ${row.seq}` };
  if (row.prev_hash !== expectedPrev)
    return { ok: false, reason: 'prev_hash does not match the previous hash' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'payload is not valid JSON' };
  }
  const canonical = canonicalJson(payload);
  // The writer stores canonical text, so any byte change shows up here even if it parses the same.
  if (canonical !== row.payload) return { ok: false, reason: 'payload is not stored in canonical form' };
  if (sha256Hex(canonical) !== row.payload_hash) return { ok: false, reason: 'payload_hash mismatch' };
  if (envelopeHash(envelopeOf(row, payload)) !== row.hash) return { ok: false, reason: 'hash mismatch' };
  return { ok: true };
}
