// Probe c1/lease-manager (WS-P1-008; backlog verify_probe runtime/lease-manager).
// Surfaces: lease functions exported by packages/ledger/src/index.ts, each called in its own node
// process through fixtures/lease-op.mjs (which opens the store the way fwd does: $FW_HOME/db/fw.sqlite,
// writer lock $FW_HOME/fwd.lock), and the `leases` table and lease.* events of schema.core.sql,
// read with node:sqlite read-only. The schema already holds the rules a lease manager rests on: one
// active lease per (resource_kind, resource_key) (uq_lease_active) and a fence_token that only grows
// per resource (trg_leases_fence_monotonic).
// The exports this probe expects (no spec names them; see probes/c1/README.md, "Decisions"):
//   acquireLease(w, { resource_kind, resource_key, holder_agent_id, ttl_ms, run_id? })
//     -> { lease_id, fence_token, expires_at }; throws (code or message naming the held lease) while
//        another unexpired active lease holds the resource. An expired one is marked expired
//        (lease.expired) and replaced in the same transaction.
//   heartbeatLease(w, { lease_id, fence_token, ttl_ms }) -> extends expires_at; throws when stale
//   releaseLease(w, { lease_id, fence_token, reason }) -> releases; throws when stale
//   checkFence(w, { resource_kind, resource_key, fence_token }) -> resolves for the live token,
//     throws for any other (what a guarded write calls before it acts)
// Acceptance (WS-P1-008):
//   1. a second claimant is refused while a lease is valid
//   2. an expired lease can be taken, and the old fencing token is rejected
//   3. lease operations are atomic under concurrent processes: two real processes race for the
//      same resource (a fresh one, and an expired one) and exactly one wins every round
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  baseEnv,
  check,
  count,
  fixtureProject,
  freshHome,
  fw,
  missing,
  openDbReadonly,
  probe,
  root,
  sleep,
} from '../c0/_lib.mjs';

const LOADER = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
const OP = join(root, 'probes/c1/fixtures/lease-op.mjs');
const ROUNDS = 6;

let home;

/** Runs one lease operation in a new node process; resolves to its JSON line. */
function leaseOp(op, args, at) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ['--import', LOADER, OP, JSON.stringify({ root, home, op, args, at })], {
      cwd: root,
      env: baseEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      try {
        ok(JSON.parse(line));
      } catch {
        ok({ ok: false, error: { name: 'ProcessError', message: `lease-op exited ${code}: ${(err || out).trim().split('\n')[0]}` } });
      }
    });
  });
}

/** One lease operation; MISSING when @fw/ledger does not export the lease manager yet. */
async function call(op, args, at) {
  const r = await leaseOp(op, args, at);
  if (r.missing) missing(`packages/ledger/src/index.ts does not export ${r.missing.join(', ')} (the lease manager)`);
  return r;
}

const describe = (r) => (r.ok ? `ok ${JSON.stringify(r.result).slice(0, 120)}` : `${r.error?.name}/${r.error?.code}: ${r.error?.message?.slice(0, 160)}`);

/** A refusal by the lease manager, not a failure to reach it. */
function isLeaseRefusal(r) {
  if (r.ok || r.stage === 'open' || r.error?.name === 'ProcessError') return false;
  return /lease|held|fenc|stale|expired/i.test(`${r.error?.code} ${r.error?.message}`);
}

async function leasesOf(kind, key) {
  const db = await openDbReadonly(home);
  const rows = db
    .prepare('SELECT id, status, fence_token, holder_agent_id, acquired_at, expires_at FROM leases WHERE resource_kind = ? AND resource_key = ? ORDER BY fence_token')
    .all(kind, key);
  const acquired = count(
    db,
    "SELECT count(*) FROM events WHERE type = 'lease.acquired' AND json_extract(payload, '$.resource_key') = ? AND json_extract(payload, '$.resource_kind') = ?",
    key,
    kind,
  );
  db.close();
  return { rows, acquired, active: rows.filter((r) => r.status === 'active') };
}

async function eventCount(type, leaseId) {
  const db = await openDbReadonly(home);
  const n = count(db, "SELECT count(*) FROM events WHERE type = ? AND json_extract(payload, '$.lease_id') = ?", type, leaseId);
  db.close();
  return n;
}

function checkAcquired(r, what) {
  check(r.ok, `${what}: ${describe(r)}`);
  const { lease_id, fence_token, expires_at } = r.result ?? {};
  check(/^lse_/.test(lease_id ?? ''), `${what}: no lease_id in the result (${JSON.stringify(r.result)})`);
  check(Number.isInteger(fence_token) && fence_token >= 1, `${what}: no integer fence_token in the result`);
  check(typeof expires_at === 'string', `${what}: no expires_at in the result`);
  return r.result;
}

await probe('c1/lease-manager', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-963' });
  home = freshHome('c1-lease');
  check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status === 0, 'fw ledger sync failed on the fixture project');
  let db = await openDbReadonly(home);
  const agents = db
    .prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id")
    .all()
    .map((a) => a.id);
  db.close();
  check(agents.length >= 2, 'fw ledger sync did not register two agents to hold leases');
  const [A, B] = agents;

  // ---- line 1: a second claimant is refused while the lease is valid ---------------------------
  const k1 = { resource_kind: 'branch', resource_key: 'fw/probe/valid' };
  const a1 = checkAcquired(await call('acquire', { ...k1, holder_agent_id: A, ttl_ms: 120000 }), 'the first claim of a free branch');
  let s = await leasesOf(k1.resource_kind, k1.resource_key);
  check(s.active.length === 1 && s.active[0].id === a1.lease_id, 'the acquired lease is not the one active row for the resource');
  check(s.active[0].fence_token === a1.fence_token, 'the returned fence_token differs from the stored one');
  check(s.acquired === 1, `${s.acquired} lease.acquired events for the first claim, want 1`);
  const b1 = await call('acquire', { ...k1, holder_agent_id: B, ttl_ms: 120000 });
  check(!b1.ok, 'a second claimant got a lease while the first was valid');
  check(isLeaseRefusal(b1), `the second claimant failed for another reason than the held lease: ${describe(b1)}`);
  s = await leasesOf(k1.resource_kind, k1.resource_key);
  check(s.rows.length === 1 && s.active[0]?.id === a1.lease_id, 'the refused claim changed the leases table');
  check(s.acquired === 1, 'the refused claim emitted lease.acquired');
  const other = await call('acquire', { resource_kind: 'branch', resource_key: 'fw/probe/other', holder_agent_id: B, ttl_ms: 120000 });
  checkAcquired(other, 'a claim of a different, free branch (a lease covers one resource only)');
  const hb = await call('heartbeat', { lease_id: a1.lease_id, fence_token: a1.fence_token, ttl_ms: 240000 });
  check(hb.ok, `the holder's heartbeat with its live token was refused: ${describe(hb)}`);
  s = await leasesOf(k1.resource_kind, k1.resource_key);
  check(s.active[0].expires_at > a1.expires_at, 'a heartbeat did not extend expires_at');

  // ---- line 2: an expired lease can be taken; the old token is rejected ------------------------
  const k2 = { resource_kind: 'worktree', resource_key: 'probe-expiring' };
  const a2 = checkAcquired(await call('acquire', { ...k2, holder_agent_id: A, ttl_ms: 400 }), 'a short lease');
  await sleep(1200);
  const b2 = checkAcquired(await call('acquire', { ...k2, holder_agent_id: B, ttl_ms: 120000 }), 'taking over an expired lease');
  check(b2.fence_token > a2.fence_token, `the new fence_token ${b2.fence_token} does not exceed the expired ${a2.fence_token}`);
  s = await leasesOf(k2.resource_kind, k2.resource_key);
  const old = s.rows.find((r) => r.id === a2.lease_id);
  check(old?.status === 'expired', `the taken-over lease is ${old?.status}, want expired`);
  check(s.active.length === 1 && s.active[0].id === b2.lease_id, 'the new lease is not the one active row for the resource');
  check((await eventCount('lease.expired', a2.lease_id)) === 1, 'no lease.expired event for the taken-over lease');
  for (const [op, args] of [
    ['heartbeat', { lease_id: a2.lease_id, fence_token: a2.fence_token, ttl_ms: 120000 }],
    ['release', { lease_id: a2.lease_id, fence_token: a2.fence_token, reason: 'probe: stale holder' }],
    ['checkFence', { ...k2, fence_token: a2.fence_token }],
  ]) {
    const r = await call(op, args);
    check(!r.ok, `${op} with the old fencing token was accepted`);
    check(isLeaseRefusal(r), `${op} with the old token failed for another reason than the stale fence: ${describe(r)}`);
  }
  const live = await call('checkFence', { ...k2, fence_token: b2.fence_token });
  check(live.ok, `checkFence with the live token was refused: ${describe(live)}`);
  s = await leasesOf(k2.resource_kind, k2.resource_key);
  check(s.active.length === 1 && s.active[0].id === b2.lease_id, 'the stale-token calls changed the live lease');

  // ---- line 3: two real processes race; exactly one wins ---------------------------------------
  const kinds = ['worktree', 'branch', 'stream'];
  for (let i = 0; i < ROUNDS; i++) {
    const k = { resource_kind: kinds[i % 3], resource_key: `probe-race-${i}` };
    const at = Date.now() + 2500;
    const rs = await Promise.all([A, B].map((h) => call('acquire', { ...k, holder_agent_id: h, ttl_ms: 120000 }, at)));
    const wins = rs.filter((r) => r.ok);
    check(wins.length === 1, `race ${i} (${k.resource_kind}): ${wins.length} winners, want 1 [${rs.map(describe).join(' | ')}]`);
    const loser = rs.find((r) => !r.ok);
    check(isLeaseRefusal(loser), `race ${i}: the loser failed for another reason than the held lease: ${describe(loser)}`);
    s = await leasesOf(k.resource_kind, k.resource_key);
    check(s.rows.length === 1 && s.active.length === 1, `race ${i}: ${s.rows.length} lease rows, ${s.active.length} active, want 1 and 1`);
    check(s.acquired === 1, `race ${i}: ${s.acquired} lease.acquired events, want 1`);
  }
  for (let i = 0; i < 2; i++) {
    const k = { resource_kind: 'stream', resource_key: `probe-race-expired-${i}` };
    const seed = checkAcquired(await call('acquire', { ...k, holder_agent_id: A, ttl_ms: 400 }), 'a short lease to race over');
    await sleep(1200);
    const at = Date.now() + 2500;
    const rs = await Promise.all([A, B].map((h) => call('acquire', { ...k, holder_agent_id: h, ttl_ms: 120000 }, at)));
    const wins = rs.filter((r) => r.ok);
    check(wins.length === 1, `expired race ${i}: ${wins.length} winners, want 1 [${rs.map(describe).join(' | ')}]`);
    s = await leasesOf(k.resource_kind, k.resource_key);
    check(s.active.length === 1 && s.rows.length === 2, `expired race ${i}: ${s.rows.length} rows, ${s.active.length} active, want 2 and 1`);
    check(s.rows.find((r) => r.id === seed.lease_id)?.status === 'expired', `expired race ${i}: the old lease is not expired`);
    const tokens = s.rows.map((r) => r.fence_token);
    check(new Set(tokens).size === tokens.length && wins[0].result.fence_token > seed.fence_token, `expired race ${i}: fence tokens ${tokens.join(',')} are not unique and growing`);
    check((await eventCount('lease.expired', seed.lease_id)) === 1, `expired race ${i}: lease.expired emitted ${await eventCount('lease.expired', seed.lease_id)} times, want 1`);
  }
});
