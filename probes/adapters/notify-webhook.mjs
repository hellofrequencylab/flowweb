// Probe for FW-C-028 (out-of-band notification webhook): `pnpm probe adapters/notify-webhook`. Tier 0.
// probe-timeout-s: 180
// Surfaces: notifyCycle exported by packages/daemon/src/index.ts and requestApproval from @fw/policy
// (FW-C-010), called with the Writer of the Store port after `fw ledger sync`; the database read-only.
// The surface this probe expects:
//   notifyCycle({ writer, now: Date, config: { url, quiet_hours?: { start: "HH:MM", end: "HH:MM" } },
//     send: async (url, body) => void }) [@fw/daemon] -> [{ kind, ref }]: one pass of the notifier.
//     It sends a pending approval once (kind "approval_pending") and once more as a reminder (kind
//     "approval_reminder") before it expires, never again. In quiet hours (local time of now) it holds
//     ordinary notifications, but a kill switch engaged (system.kill_switch_engaged) or a failed chain
//     check (audit.chain_verification_failed) is sent at once (kinds "kill_switch", "chain_failure").
//     A body names what happened and links to the UI; it never carries a diff, a secret or a message
//     body from the evidence.
//
// Proves, in order:
//   1. A pending approval sends exactly one notification and one reminder, both before it expires.
//   2. Quiet hours hold an ordinary notification but not a kill-switch or chain-failure alert.
//   3. No body sent holds the diff, the secret or the evidence's message text.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  dbPath,
  fakeSecret,
  fixtureProject,
  freshHome,
  fw,
  openDbReadonly,
  probe,
  requireExport,
  root,
  sha256,
} from '../c0/_lib.mjs';

const ROW = 'FW-C-028';
const MARK = 'probe-message-body-7f3a';

await probe('adapters/notify-webhook', async () => {
  const notifyCycle = await requireExport('daemon', 'notifyCycle', ROW);
  const requestApproval = await requireExport('policy', 'requestApproval', 'FW-C-010');
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-992' });
  const home = freshHome('notify');
  check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status === 0, 'fw ledger sync failed');
  const db = await openDbReadonly(home);
  const agent = db.prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1").get()?.id;
  db.close();

  const secret = fakeSecret('anthropic');
  const diff = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const k = '';\n+const k = '${secret}';\n`;
  const sent = [];
  const send = async (url, body) => {
    sent.push({ url, body: typeof body === 'string' ? body : JSON.stringify(body) });
  };
  const url = 'http://127.0.0.1:9/hook';
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  try {
    const w = store.writer;
    const ask = (tag) => {
      const evb = `evb_${tag}${Date.now()}`;
      w.run(
        "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, captured_by) VALUES (?, 'pull_request', '#7', ?, ?, 'kernel')",
        [evb, JSON.stringify({ diff_text: diff, message: `${MARK}: please merge this` }), sha256(evb)],
      );
      return requestApproval(w, {
        action_class: 'merge_main',
        environment: 'production',
        tier: 'L3',
        subject_kind: 'pull_request',
        subject_ref: '#7',
        payload_hash: sha256(diff),
        head_sha: 'c'.repeat(40),
        evidence_bundle_id: evb,
        requester_agent_id: agent,
        ttl_minutes: 60,
      });
    };

    // 1. One notification and one reminder.
    const a = ask('one');
    const expires = Date.parse(a.expires_at);
    const t0 = expires - 60 * 60000;
    for (let m = 0; m <= 75; m++) await notifyCycle({ writer: w, now: new Date(t0 + m * 60000 + 1000), config: { url }, send });
    const mine = sent.filter((s) => s.body.includes(a.approval_id));
    check(mine.length === 2, `the approval was sent ${mine.length} times over 75 minutes, want 2 (one notification, one reminder)`);
    check(/approval_pending/.test(mine[0].body) && /approval_reminder/.test(mine[1].body), 'the two sends are not a notification then a reminder');

    // 2. Quiet hours.
    const now = new Date();
    const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const quiet = { start: hhmm(new Date(now.getTime() - 3600000)), end: hhmm(new Date(now.getTime() + 3600000)) };
    const b = ask('two');
    const before = sent.length;
    await notifyCycle({ writer: w, now, config: { url, quiet_hours: quiet }, send });
    check(!sent.slice(before).some((s) => s.body.includes(b.approval_id)), 'an ordinary notification was sent in quiet hours');
    w.appendEvent({
      type: 'system.kill_switch_engaged',
      actor_kind: 'system',
      actor_id: 'sys_probe',
      payload: { engaged_by: 'system', channel: 'probe', credentials_revoked: 0, runs_halted: 0 },
    });
    w.appendEvent({
      type: 'audit.chain_verification_failed',
      actor_kind: 'system',
      actor_id: 'sys_probe',
      payload: { chain: 'events', first_bad_seq: 3, expected_hash: 'a'.repeat(64), found_hash: 'b'.repeat(64) },
    });
    const mid = sent.length;
    await notifyCycle({ writer: w, now: new Date(now.getTime() + 60000), config: { url, quiet_hours: quiet }, send });
    const alerts = sent.slice(mid).map((s) => s.body).join('\n');
    check(/kill_switch/.test(alerts), 'a kill-switch alert was held in quiet hours');
    check(/chain_failure/.test(alerts), 'a chain-failure alert was held in quiet hours');
    check(!sent.slice(mid).some((s) => s.body.includes(b.approval_id)), 'the held approval went out with the alerts during quiet hours');
  } finally {
    store.close();
  }

  // 3. Payload scan.
  check(sent.length > 0, 'nothing was sent');
  for (const s of sent) {
    check(!s.body.includes(secret) && !/sk-ant-/.test(s.body), 'a notification carries a secret');
    check(!/diff --git|^@@ |^\+\+\+ |^--- /m.test(s.body), 'a notification carries a diff');
    check(!s.body.includes(MARK), 'a notification carries the evidence message text');
  }
});
