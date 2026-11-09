// WS-P1-008: lease manager with expiry and fencing tokens, on a temp store with a fake clock.
import { describe, expect, test } from 'vitest';
import { acquireLease, checkFence, heartbeatLease, LeaseError, releaseLease } from '../src/index.ts';
import { fileStore, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();

function setup(name: string) {
  const store = fileStore(dir, `${name}.sqlite`);
  syncInto(store, writeRows(`${dir}/${name}-rows`, [row('FW-C-940')]));
  const w = store.writer!;
  const agents = w
    .all<{ id: string }>("SELECT id FROM agents WHERE status = 'active' ORDER BY id")
    .map((a) => a.id);
  let t = Date.parse('2026-11-09T10:00:00.000Z');
  const opts = { now: () => new Date(t) };
  const advance = (ms: number) => {
    t += ms;
  };
  const events = (type: string) =>
    w
      .all<{ payload: string }>('SELECT payload FROM events WHERE type = ? ORDER BY seq', [type])
      .map((e) => JSON.parse(e.payload));
  const leases = (key: string) =>
    w.all<{ id: string; status: string; fence_token: number }>(
      'SELECT id, status, fence_token FROM leases WHERE resource_key = ? ORDER BY fence_token',
      [key],
    );
  return { store, w, A: agents[0]!, B: agents[1]!, opts, advance, events, leases };
}

function refusal(fn: () => unknown): LeaseError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LeaseError);
    return e as LeaseError;
  }
  throw new Error('expected a lease refusal');
}

describe('lease manager', () => {
  test('a second claimant is refused while the lease is valid; another resource is free', () => {
    const { w, A, B, opts, events, leases } = setup('held');
    const k = { resource_kind: 'branch', resource_key: 'fw/a' };
    const a = acquireLease(w, { ...k, holder_agent_id: A, ttl_ms: 60000 }, opts);
    expect(a.lease_id).toMatch(/^lse_/);
    expect(a.fence_token).toBe(1);
    expect(a.expires_at).toBe('2026-11-09T10:01:00.000Z');
    expect(refusal(() => acquireLease(w, { ...k, holder_agent_id: B, ttl_ms: 60000 }, opts)).code).toBe(
      'LEASE_HELD',
    );
    expect(leases('fw/a')).toHaveLength(1);
    expect(events('lease.acquired')).toHaveLength(1);
    expect(events('lease.acquired')[0]).toMatchObject({
      lease_id: a.lease_id,
      ...k,
      holder_agent_id: A,
      fence_token: 1,
    });
    expect(
      acquireLease(
        w,
        { resource_kind: 'branch', resource_key: 'fw/b', holder_agent_id: B, ttl_ms: 60000 },
        opts,
      ).fence_token,
    ).toBe(1);
  });

  test('a heartbeat extends the lease; it then outlives its first ttl', () => {
    const { w, A, B, opts, advance } = setup('heartbeat');
    const k = { resource_kind: 'worktree', resource_key: 'wt' };
    const a = acquireLease(w, { ...k, holder_agent_id: A, ttl_ms: 1000 }, opts);
    advance(800);
    const hb = heartbeatLease(w, { lease_id: a.lease_id, fence_token: a.fence_token, ttl_ms: 1000 }, opts);
    expect(hb.expires_at > a.expires_at).toBe(true);
    advance(800);
    expect(refusal(() => acquireLease(w, { ...k, holder_agent_id: B, ttl_ms: 1000 }, opts)).code).toBe(
      'LEASE_HELD',
    );
    expect(checkFence(w, { ...k, fence_token: a.fence_token }, opts).lease_id).toBe(a.lease_id);
  });

  test('an expired lease is taken over with a larger token; the old token is refused everywhere', () => {
    const { w, A, B, opts, advance, events, leases } = setup('expired');
    const k = { resource_kind: 'stream', resource_key: 'st' };
    const a = acquireLease(w, { ...k, holder_agent_id: A, ttl_ms: 1000 }, opts);
    advance(1000);
    expect(refusal(() => checkFence(w, { ...k, fence_token: a.fence_token }, opts)).code).toBe('STALE_FENCE');
    expect(
      refusal(() => heartbeatLease(w, { lease_id: a.lease_id, fence_token: 1, ttl_ms: 1000 }, opts)).code,
    ).toBe('STALE_FENCE');
    const b = acquireLease(w, { ...k, holder_agent_id: B, ttl_ms: 1000 }, opts);
    expect(b.fence_token).toBe(2);
    expect(leases('st').map((l) => l.status)).toEqual(['expired', 'active']);
    expect(events('lease.expired')).toEqual([
      { lease_id: a.lease_id, last_heartbeat_at: '2026-11-09T10:00:00.000Z' },
    ]);
    expect(
      refusal(() => releaseLease(w, { lease_id: a.lease_id, fence_token: 1, reason: 'stale' }, opts)).code,
    ).toBe('STALE_FENCE');
    expect(refusal(() => checkFence(w, { ...k, fence_token: 1 }, opts)).code).toBe('STALE_FENCE');
    expect(
      refusal(() => releaseLease(w, { lease_id: b.lease_id, fence_token: 1, reason: 'wrong token' }, opts))
        .code,
    ).toBe('STALE_FENCE');
    expect(checkFence(w, { ...k, fence_token: 2 }, opts).lease_id).toBe(b.lease_id);
  });

  test('release frees the resource with one lease.released; the next token still grows', () => {
    const { w, A, B, opts, events, leases } = setup('release');
    const k = { resource_kind: 'branch', resource_key: 'rel' };
    const a = acquireLease(w, { ...k, holder_agent_id: A, ttl_ms: 60000 }, opts);
    releaseLease(w, { lease_id: a.lease_id, fence_token: a.fence_token, reason: 'done' }, opts);
    expect(events('lease.released')).toEqual([{ lease_id: a.lease_id, reason: 'done' }]);
    expect(
      refusal(() => releaseLease(w, { lease_id: a.lease_id, fence_token: 1, reason: 'again' }, opts)).code,
    ).toBe('STALE_FENCE');
    expect(acquireLease(w, { ...k, holder_agent_id: B, ttl_ms: 60000 }, opts).fence_token).toBe(2);
    expect(leases('rel').map((l) => l.status)).toEqual(['released', 'active']);
  });

  test('bad arguments are refused before anything is written', () => {
    const { w, A, opts, leases } = setup('args');
    for (const ttl_ms of [0, -1, 1.5, Number.NaN]) {
      const e = refusal(() =>
        acquireLease(w, { resource_kind: 'branch', resource_key: 'x', holder_agent_id: A, ttl_ms }, opts),
      );
      expect(e.code).toBe('BAD_LEASE_ARGUMENT');
    }
    expect(
      refusal(() => heartbeatLease(w, { lease_id: 'lse_nope', fence_token: 1, ttl_ms: 10 }, opts)).code,
    ).toBe('LEASE_NOT_FOUND');
    expect(leases('x')).toHaveLength(0);
  });
});
