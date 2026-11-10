// Probe for FW-C-011 (merge slot and merge executor): `pnpm probe policy/merge-slot`. Tier 0.
// probe-timeout-s: 180
// Surfaces: LocalBareHost from packages/daemon/src/index.ts on a scratch bare repo; the approval
// functions of FW-C-010 and the merge-slot functions exported by packages/policy/src/index.ts and
// packages/daemon/src/index.ts, called with the Writer of the Store port; the database read-only.
// The surface this probe expects:
//   host.merge(number, { expectedHead }) refuses (GitHostError, message naming the stale head) when
//     the PR head is not expectedHead, and changes nothing on the host.
//   requestMergeSlot(w, { approval_id, pr_number, base }) [@fw/policy] -> { grant_id, status }:
//     status "active" when no other merge_slot grant for that base is active, else "queued";
//     merge_slot.requested, plus merge_slot.granted when active.
//   executeMerge({ writer, host, grant_id }) [@fw/daemon] -> { merged, reason?, merged_sha? }:
//     refuses a grant that is not active (reason "not_active"); re-reads the PR head from the host
//     and, when it differs from the approval's head_sha, voids the slot (merge_slot.void) and revokes
//     the approval (status revoked) without merging (reason "head_moved"); otherwise merges with
//     expectedHead = the approval's head_sha, consumes the grant and the approval, records
//     merge_slot.landed, and hands the slot to the next queued grant for that base, rechecking the
//     base tip (merge_slot.granted with payload base_sha = the new tip).
//
// Proves, in order:
//   1. The host refuses a merge whose expected head is stale.
//   2. Two approved PRs queue: the second is queued and cannot merge until the first lands; after it
//      lands the second is granted on the new base tip and merges.
//   3. A push after approval voids the slot and the approval, and nothing lands on main.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, dbPath, fixtureProject, freshHome, fw, git, openDbReadonly, probe, requireExport, root, sha256, tmpDir, writeFiles } from '../c0/_lib.mjs';

const ROW = 'FW-C-011';

await probe('policy/merge-slot', async () => {
  const requestApproval = await requireExport('policy', 'requestApproval', 'FW-C-010');
  const respondApproval = await requireExport('policy', 'respondApproval', 'FW-C-010');
  const requestMergeSlot = await requireExport('policy', 'requestMergeSlot', ROW);
  const executeMerge = await requireExport('daemon', 'executeMerge', ROW);
  const LocalBareHost = await requireExport('daemon', 'LocalBareHost', ROW);
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-973' });
  const host = new LocalBareHost(proj.remote);
  const home = freshHome('merge-slot');
  check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status === 0, 'fw ledger sync failed');
  const db0 = await openDbReadonly(home);
  const agent = db0.prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1").get()?.id;
  const owner = JSON.parse(db0.prepare("SELECT value FROM settings WHERE key = 'owner'").get().value).id;
  db0.close();

  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  const w = store.writer;
  const count = (_w, sql) => Number(Object.values(w.get(sql) ?? {})[0] ?? 0);
  const main = () => git(proj.work, 'ls-remote', proj.remote, 'refs/heads/main').split(/\s/)[0];
  const branch = (name, file) => {
    git(proj.work, 'checkout', '-q', '-B', name, 'origin/main');
    writeFiles(proj.work, { [file]: `${name}\n` });
    git(proj.work, 'add', '.');
    git(proj.work, 'commit', '-qm', name);
    git(proj.work, 'push', '-q', 'origin', name);
    return git(proj.work, 'rev-parse', 'HEAD').trim();
  };
  const approved = async (n, head) => {
    const evb = `evb_ms${n}${Date.now()}`;
    w.run(
      "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, captured_by) VALUES (?, 'pull_request', ?, '{}', ?, 'kernel')",
      [evb, `#${n}`, sha256(evb)],
    );
    const hash = sha256(`diff of #${n} at ${head}`);
    const a = requestApproval(w, {
      action_class: 'merge_main',
      environment: 'production',
      tier: 'L3',
      subject_kind: 'pull_request',
      subject_ref: `#${n}`,
      payload_hash: hash,
      head_sha: head,
      evidence_bundle_id: evb,
      requester_agent_id: agent,
      ttl_minutes: 60,
    });
    respondApproval(w, a.approval_id, { decision: 'approve', payload_hash: hash, head_sha: head, method: 'deck_click' }, { kind: 'owner', id: owner, paired: true });
    return a.approval_id;
  };
  try {
    git(proj.work, 'fetch', '-q', 'origin');
    // 1. Stale expected head.
    const h0 = branch('feat-zero', 'zero.txt');
    const pr0 = await host.openPullRequest({ head: 'feat-zero', base: 'main', title: 'zero', body: '' });
    const before = main();
    let staleRefused = false;
    try {
      await host.merge(pr0.number, { expectedHead: 'f'.repeat(40) });
    } catch (e) {
      staleRefused = /stale|expected/i.test(String(e?.message));
    }
    check(staleRefused, 'the host merged although expectedHead was not the PR head');
    check(main() === before, 'a refused stale-head merge moved main');
    await host.close(pr0.number);
    check(h0, 'no head for the first fixture branch');

    // 2. Two PRs queue.
    const h1 = branch('feat-one', 'one.txt');
    const h2 = branch('feat-two', 'two.txt');
    const pr1 = await host.openPullRequest({ head: 'feat-one', base: 'main', title: 'one', body: '' });
    const pr2 = await host.openPullRequest({ head: 'feat-two', base: 'main', title: 'two', body: '' });
    const s1 = requestMergeSlot(w, { approval_id: await approved(pr1.number, h1), pr_number: pr1.number, base: 'main' });
    const s2 = requestMergeSlot(w, { approval_id: await approved(pr2.number, h2), pr_number: pr2.number, base: 'main' });
    check(s1?.status === 'active', `the first slot is ${s1?.status}, want active`);
    check(s2?.status === 'queued', `the second slot is ${s2?.status}, want queued`);
    const early = await executeMerge({ writer: w, host, grant_id: s2.grant_id });
    check(early?.merged === false && early.reason === 'not_active', 'a queued slot merged before the first landed');
    check(main() === before, 'main moved before the first slot landed');
    const m1 = await executeMerge({ writer: w, host, grant_id: s1.grant_id });
    check(m1?.merged === true, `the first slot did not merge: ${m1?.reason}`);
    const tip1 = main();
    check(tip1 !== before, 'main did not move when the first slot landed');
    const granted = w.all("SELECT payload FROM events WHERE type = 'merge_slot.granted' ORDER BY seq").map((e) => JSON.parse(e.payload));
    check(
      granted.some((p) => JSON.stringify(p).includes(s2.grant_id) && p.base_sha === tip1),
      'the second slot was not granted on the new base tip after the first landed',
    );
    const m2 = await executeMerge({ writer: w, host, grant_id: s2.grant_id });
    check(m2?.merged === true, `the second slot did not merge after the first landed: ${m2?.reason}`);
    check(count(w, "SELECT count(*) FROM events WHERE type = 'merge_slot.landed'") === 2, 'want two merge_slot.landed events');

    // 3. Push after approval voids the slot and the approval.
    git(proj.work, 'fetch', '-q', 'origin');
    const h3 = branch('feat-three', 'three.txt');
    const pr3 = await host.openPullRequest({ head: 'feat-three', base: 'main', title: 'three', body: '' });
    const a3 = await approved(pr3.number, h3);
    const s3 = requestMergeSlot(w, { approval_id: a3, pr_number: pr3.number, base: 'main' });
    writeFiles(proj.work, { 'three.txt': 'changed after approval\n' });
    git(proj.work, 'commit', '-qam', 'pushed after approval');
    git(proj.work, 'push', '-q', 'origin', 'feat-three');
    const tipBefore = main();
    const m3 = await executeMerge({ writer: w, host, grant_id: s3.grant_id });
    check(m3?.merged === false && m3.reason === 'head_moved', `a slot whose PR moved after approval gave ${JSON.stringify(m3)}`);
    check(main() === tipBefore, 'something landed on main after the PR head moved');
    check((await host.getPrStatus(pr3.number)).state === 'open', 'the moved PR is not open');
    check(w.get('SELECT status FROM approvals WHERE id = ?', [a3])?.status === 'revoked', 'the approval was not revoked when the head moved');
    check(count(w, "SELECT count(*) FROM events WHERE type = 'merge_slot.void'") >= 1, 'no merge_slot.void for the moved PR');
  } finally {
    store.close();
  }
  void tmpDir;
});
