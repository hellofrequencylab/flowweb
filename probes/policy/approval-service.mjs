// Probe for FW-C-010 (approval service: hash-bound, Owner only, default deny):
// `pnpm probe policy/approval-service`. Tier 0.
// probe-timeout-s: 180
// Surfaces: the approval functions exported by packages/policy/src/index.ts, called with the Writer of
// the Store port (openStore from @fw/eventlog, opened the way fwd opens it); a real fwd on loopback
// for POST /v1/approvals/{id}/respond (docs/api/LOCAL-API-V1.md); the database read-only.
// The surface this probe expects:
//   requestApproval(w, { action_class, environment, tier, subject_kind, subject_ref, payload_hash,
//     head_sha?, evidence_bundle_id, requester_agent_id, ttl_minutes }) -> { approval_id, expires_at }
//     one pending approvals row and one approval.requested event
//   respondApproval(w, approval_id, { decision: "approve"|"deny", payload_hash, head_sha?, method },
//     actor: { kind: "owner"|"agent"|"session", id, paired: boolean })
//     -> { status } on success; throws an error whose code is one of hash_mismatch, expired,
//     not_owner, unpaired otherwise. A hash mismatch records approval.rejected_hash_mismatch and
//     leaves the approval pending.
//   expireApprovals(w, now?) -> [{ approval_id, default_applied: "deny" }]: every pending approval
//     past expires_at becomes expired with one approval.expired event (payload default_applied deny)
//   POST /v1/approvals/{id}/respond without a session answers 401 and changes nothing; with a
//   payload_hash that differs it answers 409 stale_hash.
//
// Proves, in order:
//   1. A response whose payload_hash differs is rejected (hash_mismatch), recorded as
//      approval.rejected_hash_mismatch, and the approval stays pending.
//   2. An agent identity and an unpaired session are both refused; the approval stays pending.
//   3. The Owner, paired, with the right hash, approves it.
//   4. An approval past expires_at cannot be used (expired) and the sweep applies deny with one
//      approval.expired; a second sweep changes nothing.
//   5. Over HTTP: no session gives 401, a wrong hash gives 409 stale_hash, nothing approved.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  count,
  dbPath,
  fixtureProject,
  freshHome,
  fw,
  openDbReadonly,
  probe,
  requireExport,
  root,
  sha256,
  sleep,
} from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const ROW = 'FW-C-010';

await probe('policy/approval-service', async () => {
  const requestApproval = await requireExport('policy', 'requestApproval', ROW);
  const respondApproval = await requireExport('policy', 'respondApproval', ROW);
  const expireApprovals = await requireExport('policy', 'expireApprovals', ROW);
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-972' });
  const home = freshHome('approvals');
  check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status === 0, 'fw ledger sync failed');
  let db = await openDbReadonly(home);
  const agent = db.prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1").get()?.id;
  const ownerRow = db.prepare("SELECT value FROM settings WHERE key = 'owner'").get();
  const owner = ownerRow ? JSON.parse(ownerRow.value).id : undefined;
  db.close();
  check(agent && owner, 'fw ledger sync did not register an agent and the Owner');

  const withWriter = (fn) => {
    const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
    try {
      return fn(store.writer);
    } finally {
      store.close();
    }
  };
  const refusal = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return String(e?.code ?? e?.message ?? e);
    }
  };
  const statusOf = async (id) => {
    const d = await openDbReadonly(home);
    try {
      return d.prepare('SELECT status FROM approvals WHERE id = ?').get(id)?.status;
    } finally {
      d.close();
    }
  };
  const evb = `evb_probe${Date.now()}`;
  withWriter((w) =>
    w.run(
      "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, captured_by) VALUES (?, 'probe', 'approvals', '{}', ?, 'kernel')",
      [evb, sha256(evb)],
    ),
  );
  const hash = sha256('the exact diff the Owner reviewed');
  const head = 'a'.repeat(40);
  const ask = (ttl) =>
    withWriter((w) =>
      requestApproval(w, {
        action_class: 'code_write_sandbox',
        environment: 'sandbox',
        tier: 'L2',
        subject_kind: 'pull_request',
        subject_ref: 'probe#1',
        payload_hash: hash,
        head_sha: head,
        evidence_bundle_id: evb,
        requester_agent_id: agent,
        ttl_minutes: ttl,
      }),
    );
  const ownerActor = { kind: 'owner', id: owner, paired: true };

  // 1. Hash mismatch.
  const a = ask(60);
  check(a?.approval_id?.startsWith('apr_'), 'requestApproval did not return an approval_id');
  check((await statusOf(a.approval_id)) === 'pending', 'a requested approval is not pending');
  const bad = refusal(() =>
    withWriter((w) =>
      respondApproval(w, a.approval_id, { decision: 'approve', payload_hash: sha256('another diff'), head_sha: head, method: 'deck_click' }, ownerActor),
    ),
  );
  check(bad && /hash_mismatch/.test(bad), `a response with a different payload_hash was not refused as hash_mismatch (got ${bad})`);
  db = await openDbReadonly(home);
  check(
    count(db, "SELECT count(*) FROM events WHERE type = 'approval.rejected_hash_mismatch' AND payload LIKE ?", `%${a.approval_id}%`) === 1,
    'no single approval.rejected_hash_mismatch event for the refused response',
  );
  db.close();
  check((await statusOf(a.approval_id)) === 'pending', 'a refused response changed the approval');

  // 2. Agent identity and unpaired session.
  const good = { decision: 'approve', payload_hash: hash, head_sha: head, method: 'deck_click' };
  const asAgent = refusal(() => withWriter((w) => respondApproval(w, a.approval_id, good, { kind: 'agent', id: agent, paired: true })));
  check(asAgent && /not_owner/.test(asAgent), `an agent identity was not refused as not_owner (got ${asAgent})`);
  const unpaired = refusal(() => withWriter((w) => respondApproval(w, a.approval_id, good, { kind: 'session', id: owner, paired: false })));
  check(unpaired && /unpaired/.test(unpaired), `an unpaired session was not refused as unpaired (got ${unpaired})`);
  check((await statusOf(a.approval_id)) === 'pending', 'a refused identity changed the approval');

  // 3. The Owner approves.
  const okRes = withWriter((w) => respondApproval(w, a.approval_id, good, ownerActor));
  check(okRes?.status === 'approved' && (await statusOf(a.approval_id)) === 'approved', 'the Owner with the right hash could not approve');

  // 4. Expiry applies deny.
  const b = ask(0.01);
  await sleep(1500);
  const late = refusal(() => withWriter((w) => respondApproval(w, b.approval_id, good, ownerActor)));
  check(late && /expired/.test(late), `an approval past expires_at was usable (got ${late})`);
  const swept = withWriter((w) => expireApprovals(w));
  const mine = (swept ?? []).find((x) => x.approval_id === b.approval_id);
  check(mine?.default_applied === 'deny', 'the sweep did not apply deny to the expired approval');
  check((await statusOf(b.approval_id)) === 'expired', 'the expired approval is not expired');
  const again = withWriter((w) => expireApprovals(w));
  check((again ?? []).length === 0, 'a second sweep expired something again');
  db = await openDbReadonly(home);
  const exp = db.prepare("SELECT payload FROM events WHERE type = 'approval.expired' AND payload LIKE ?").all(`%${b.approval_id}%`);
  db.close();
  check(exp.length === 1 && JSON.parse(exp[0].payload).default_applied === 'deny', 'no single approval.expired with default_applied deny');

  // 5. HTTP.
  const c = ask(60);
  const fwd = await startFwd(home, { args: [] });
  try {
    const path = `/v1/approvals/${c.approval_id}/respond`;
    const none = await api(fwd.port, 'POST', path, { body: good });
    check(none.status === 401, `respond without a session answered ${none.status}, want 401`);
    const wrong = await api(fwd.port, 'POST', path, { auth: fwd.token, body: { ...good, payload_hash: sha256('x') } });
    check(wrong.status === 409 && wrong.json?.error?.code === 'stale_hash', `respond with a wrong hash answered ${wrong.status} ${wrong.json?.error?.code}`);
  } finally {
    await fwd.stop();
  }
  check((await statusOf(c.approval_id)) === 'pending', 'an HTTP response without a session or with a wrong hash changed the approval');
});
