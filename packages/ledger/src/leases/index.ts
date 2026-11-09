// Lease manager: time-limited leases on a worktree, branch or stream (or any resource_kind the
// schema allows), each with a holder, an expiry and a fencing token.
// The schema holds the hard rules: one active lease per resource (uq_lease_active) and a fence token
// that only grows per resource (trg_leases_fence_monotonic). This module adds expiry: an active
// lease past its expires_at no longer counts, is marked expired (one lease.expired) by the next
// claimant, and its token is refused from then on. Every operation runs in one IMMEDIATE
// transaction, so two claimants never both see the resource free.
import { newId, nowIso, type Reader, type Writer } from '@fw/eventlog';

export type LeaseErrorCode = 'LEASE_HELD' | 'STALE_FENCE' | 'LEASE_NOT_FOUND' | 'BAD_LEASE_ARGUMENT';

/** A refusal by the lease manager. Callers branch on `code`. */
export class LeaseError extends Error {
  readonly code: LeaseErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: LeaseErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
    this.details = details;
  }
}

export interface LeaseOptions {
  /** Clock override for tests. */
  now?: () => Date;
}

export interface AcquireLeaseInput {
  resource_kind: string;
  resource_key: string;
  holder_agent_id: string;
  ttl_ms: number;
  run_id?: string | null;
}

export interface LeaseGrant {
  lease_id: string;
  fence_token: number;
  expires_at: string;
}

interface LeaseRow {
  id: string;
  resource_kind: string;
  resource_key: string;
  run_id: string | null;
  status: string;
  fence_token: number;
  heartbeat_at: string;
  expires_at: string;
}

const ACTOR = { actor_kind: 'system', actor_id: 'fwd.leases' } as const;
const COLUMNS = 'id, resource_kind, resource_key, run_id, status, fence_token, heartbeat_at, expires_at';

function clock(opts: LeaseOptions): Date {
  return opts.now ? opts.now() : new Date();
}

function ttlOf(ttl_ms: unknown): number {
  if (typeof ttl_ms !== 'number' || !Number.isInteger(ttl_ms) || ttl_ms <= 0)
    throw new LeaseError(
      'BAD_LEASE_ARGUMENT',
      `lease ttl_ms must be a positive integer, got ${String(ttl_ms)}`,
    );
  return ttl_ms;
}

function text(name: string, v: unknown): string {
  if (typeof v !== 'string' || v === '')
    throw new LeaseError('BAD_LEASE_ARGUMENT', `lease ${name} must be a non-empty string`);
  return v;
}

function markExpired(w: Writer, lease: LeaseRow, at: string): void {
  w.run("UPDATE leases SET status = 'expired', released_at = ? WHERE id = ? AND status = 'active'", [
    at,
    lease.id,
  ]);
  w.appendEvent({
    ...ACTOR,
    type: 'lease.expired',
    run_id: lease.run_id,
    idempotency_key: `${lease.id}:expired`,
    payload: { lease_id: lease.id, last_heartbeat_at: lease.heartbeat_at },
  });
}

/**
 * Claims a resource for ttl_ms. Refused (LEASE_HELD) while another unexpired active lease holds it.
 * An expired active lease is marked expired and replaced in the same transaction; the new fence
 * token exceeds every earlier one for the resource.
 */
export function acquireLease(w: Writer, input: AcquireLeaseInput, opts: LeaseOptions = {}): LeaseGrant {
  const kind = text('resource_kind', input?.resource_kind);
  const key = text('resource_key', input?.resource_key);
  const holder = text('holder_agent_id', input?.holder_agent_id);
  const ttl = ttlOf(input?.ttl_ms);
  return w.transaction((tx) => {
    const t = clock(opts);
    const at = nowIso(t);
    const current = tx.get<LeaseRow>(
      `SELECT ${COLUMNS} FROM leases WHERE resource_kind = ? AND resource_key = ? AND status = 'active'`,
      [kind, key],
    );
    if (current) {
      if (current.expires_at > at)
        throw new LeaseError(
          'LEASE_HELD',
          `lease held: ${kind} ${key} is held by lease ${current.id} until ${current.expires_at}`,
          { lease_id: current.id, expires_at: current.expires_at },
        );
      markExpired(tx, current, at);
    }
    const max = tx.get<{ m: number | null }>(
      'SELECT MAX(fence_token) AS m FROM leases WHERE resource_kind = ? AND resource_key = ?',
      [kind, key],
    );
    const fence_token = (max?.m ?? 0) + 1;
    const lease_id = newId('lse', t.getTime());
    const expires_at = nowIso(new Date(t.getTime() + ttl));
    tx.run(
      `INSERT INTO leases (id, resource_kind, resource_key, holder_agent_id, run_id, status, fence_token,
         acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [lease_id, kind, key, holder, input.run_id ?? null, fence_token, at, at, expires_at],
    );
    tx.appendEvent({
      ...ACTOR,
      type: 'lease.acquired',
      run_id: input.run_id ?? null,
      idempotency_key: lease_id,
      payload: {
        lease_id,
        resource_kind: kind,
        resource_key: key,
        holder_agent_id: holder,
        expires_at,
        fence_token,
      },
    });
    return { lease_id, fence_token, expires_at };
  });
}

/** The lease if it is active, unexpired and the token is its own; STALE_FENCE otherwise. */
function liveLease(r: Reader, lease_id: string, fence_token: unknown, at: string): LeaseRow {
  const lease = r.get<LeaseRow>(`SELECT ${COLUMNS} FROM leases WHERE id = ?`, [lease_id]);
  if (!lease) throw new LeaseError('LEASE_NOT_FOUND', `lease ${lease_id} does not exist`);
  if (lease.fence_token !== fence_token)
    throw new LeaseError('STALE_FENCE', `stale fence token ${String(fence_token)} for lease ${lease_id}`);
  if (lease.status !== 'active')
    throw new LeaseError('STALE_FENCE', `lease ${lease_id} is ${lease.status}; its fence token is stale`);
  if (lease.expires_at <= at)
    throw new LeaseError(
      'STALE_FENCE',
      `lease ${lease_id} expired at ${lease.expires_at}; its fence token is stale`,
    );
  return lease;
}

/** Extends a live lease to now + ttl_ms. Refused for a stale token or an expired lease. */
export function heartbeatLease(
  w: Writer,
  input: { lease_id: string; fence_token: number; ttl_ms: number },
  opts: LeaseOptions = {},
): LeaseGrant {
  const id = text('lease_id', input?.lease_id);
  const ttl = ttlOf(input?.ttl_ms);
  return w.transaction((tx) => {
    const t = clock(opts);
    const at = nowIso(t);
    const lease = liveLease(tx, id, input.fence_token, at);
    const expires_at = nowIso(new Date(t.getTime() + ttl));
    tx.run("UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND status = 'active'", [
      at,
      expires_at,
      id,
    ]);
    return { lease_id: id, fence_token: lease.fence_token, expires_at };
  });
}

/** Releases a live lease, one lease.released. Refused for a stale token or an expired lease. */
export function releaseLease(
  w: Writer,
  input: { lease_id: string; fence_token: number; reason: string },
  opts: LeaseOptions = {},
): { lease_id: string; released_at: string } {
  const id = text('lease_id', input?.lease_id);
  const reason = text('reason', input?.reason);
  return w.transaction((tx) => {
    const at = nowIso(clock(opts));
    const lease = liveLease(tx, id, input.fence_token, at);
    tx.run("UPDATE leases SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'", [
      at,
      id,
    ]);
    tx.appendEvent({
      ...ACTOR,
      type: 'lease.released',
      run_id: lease.run_id,
      idempotency_key: `${id}:released`,
      payload: { lease_id: id, reason },
    });
    return { lease_id: id, released_at: at };
  });
}

/**
 * Passes only for the live token of the resource's active, unexpired lease; what a guarded write
 * calls before it acts. Any other token throws STALE_FENCE.
 */
export function checkFence(
  r: Reader,
  input: { resource_kind: string; resource_key: string; fence_token: number },
  opts: LeaseOptions = {},
): LeaseGrant {
  const kind = text('resource_kind', input?.resource_kind);
  const key = text('resource_key', input?.resource_key);
  const at = nowIso(clock(opts));
  const lease = r.get<LeaseRow>(
    `SELECT ${COLUMNS} FROM leases WHERE resource_kind = ? AND resource_key = ? AND status = 'active'`,
    [kind, key],
  );
  if (!lease || lease.fence_token !== input.fence_token || lease.expires_at <= at)
    throw new LeaseError(
      'STALE_FENCE',
      `stale fence token ${String(input?.fence_token)} for ${kind} ${key}`,
      {
        live_fence_token: lease && lease.expires_at > at ? lease.fence_token : null,
      },
    );
  return { lease_id: lease.id, fence_token: lease.fence_token, expires_at: lease.expires_at };
}
