// Probe for FW-C-021 (Captain's Table, the decision-card inbox): `pnpm probe ui/captains-table`. Tier 0.
// probe-timeout-s: 420
// Surfaces: requestApproval (@fw/policy, FW-C-010) and createDecisionItem / expireDecisionItems
// (@fw/ledger, WS-P1-024) with the Writer of the Store port to set up cards; LocalBareHost
// (@fw/daemon) for a fixture pull request; a real fwd serving the built web bundle
// (probes/lib/web.mjs), paired, driven with Playwright's Chromium; the database read-only.
// The surface this probe expects:
//   /table with zero open cards (fwd says so) shows the empty state "All signed off."; when the
//   decision-cards request fails it shows a load error and never that empty state.
//   /table/<card id> for an approve card has an Approve button. Approving posts
//   POST /v1/approvals/<approval id>/respond with the approval's payload_hash and head_sha, and the
//   approval becomes approved.
//   When the pull request's head moves after the approval was requested, the card shows that it
//   changed ("Changed while you were looking") with Approve unavailable, and nothing merges.
//   An expired approve card shows its default ("Denied by default") and who applied it ("applied by
//   fwd").
//
// Proves, in order:
//   1. The empty state appears for zero open cards, and not when the load fails.
//   2. Approve posts a response bound to the payload hash and head SHA.
//   3. A moved head shows the stale state, and main does not move.
//   4. An expired card shows its default and who applied it.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  dbPath,
  fixtureProject,
  fw,
  git,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  root,
  sha256,
  sleep,
  writeFiles,
} from '../c0/_lib.mjs';
import { browser, pairedPage, startUi } from '../lib/web.mjs';

const ROW = 'FW-C-021';

await probe('ui/captains-table', async () => {
  const requestApproval = await requireExport('policy', 'requestApproval', 'FW-C-010');
  const createDecisionItem = await requireExport('ledger', 'createDecisionItem', 'WS-P1-024');
  const expireDecisionItems = await requireExport('ledger', 'expireDecisionItems', 'WS-P1-024');
  const LocalBareHost = await requireExport('daemon', 'LocalBareHost', ROW);
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-983' });
  const home = pipelineHome('table');
  const env = pipelineEnv();
  check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work, env }).status === 0, 'fw ledger sync failed');
  let db = await openDbReadonly(home);
  const agent = db.prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1").get()?.id;
  const projectId = db.prepare("SELECT project_id FROM ledger_rows WHERE id = 'lr_FWC983'").get()?.project_id;
  db.close();
  const host = new LocalBareHost(proj.remote);
  const main = () => git(proj.work, 'ls-remote', proj.remote, 'refs/heads/main').split(/\s/)[0];

  const branch = (name) => {
    git(proj.work, 'checkout', '-q', '-B', name, 'origin/main');
    writeFiles(proj.work, { [`${name}.txt`]: `${name}\n` });
    git(proj.work, 'add', '.');
    git(proj.work, 'commit', '-qm', name);
    git(proj.work, 'push', '-q', 'origin', name);
    return git(proj.work, 'rev-parse', 'HEAD').trim();
  };
  const card = async (w, name, head, prNumber, deadlineMs) => {
    const evb = `evb_${name}${Date.now()}`;
    w.run(
      "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, captured_by) VALUES (?, 'pull_request', ?, '{}', ?, 'kernel')",
      [evb, `#${prNumber}`, sha256(evb)],
    );
    const hash = sha256(`diff ${name} ${head}`);
    const a = requestApproval(w, {
      action_class: 'merge_main',
      environment: 'production',
      tier: 'L3',
      subject_kind: 'pull_request',
      subject_ref: `#${prNumber}`,
      payload_hash: hash,
      head_sha: head,
      evidence_bundle_id: evb,
      requester_agent_id: agent,
      ttl_minutes: 60,
    });
    const c = createDecisionItem(w, {
      variant: 'approve',
      project: projectId,
      ask: `Merge ${name}?`,
      approval_id: a.approval_id,
      evidence_bundle_id: evb,
      headline: `${name} lands on main.`,
      payload_preview: { format: 'diff', excerpt: name, full_ref: `#${prNumber}`, payload_hash: hash },
      risk: { blast_radius: 'one file', reversible: true, scan_status: 'green' },
      default_on_timeout: 'deny',
      deadline: new Date(Date.now() + deadlineMs).toISOString(),
    });
    return { card_id: c.card_id, approval_id: a.approval_id, hash, head };
  };

  const ui0 = await startUi(home, { env });
  const br = await browser();
  let ui = ui0;
  try {
    // 1. Empty state, honestly.
    let page = await pairedPage(ui, br);
    await page.goto(`${ui.base}/table`);
    await page.getByText('All signed off.').waitFor({ timeout: 15000 });
    await page.route('**/v1/decision-cards**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"probe"}}' }));
    await page.reload();
    await sleep(3000);
    check((await page.getByText('All signed off.').count()) === 0, 'the empty state showed although loading the cards failed');
    await page.context().close();
    await ui.stop();

    // Cards: one to approve, one whose head moves, one that expires.
    const hA = branch('feat-a');
    const hB = branch('feat-b');
    const hC = branch('feat-c');
    const prA = await host.openPullRequest({ head: 'feat-a', base: 'main', title: 'a', body: '' });
    const prB = await host.openPullRequest({ head: 'feat-b', base: 'main', title: 'b', body: '' });
    const prC = await host.openPullRequest({ head: 'feat-c', base: 'main', title: 'c', body: '' });
    const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
    let A, B, C;
    try {
      A = await card(store.writer, 'a', hA, prA.number, 3600000);
      B = await card(store.writer, 'b', hB, prB.number, 3600000);
      C = await card(store.writer, 'c', hC, prC.number, 500);
      await sleep(1500);
      expireDecisionItems(store.writer);
    } finally {
      store.close();
    }
    git(proj.work, 'checkout', '-q', 'feat-b');
    writeFiles(proj.work, { 'feat-b.txt': 'moved after approval was asked\n' });
    git(proj.work, 'commit', '-qam', 'moved');
    git(proj.work, 'push', '-q', 'origin', 'feat-b');
    const tip = main();

    ui = await startUi(home, { env });
    page = await pairedPage(ui, br);

    // 2. Approve binds hash and head.
    const posted = [];
    page.on('request', (req) => {
      if (/\/v1\/approvals\/[^/]+\/respond$/.test(req.url())) posted.push({ url: req.url(), body: req.postDataJSON() });
    });
    await page.goto(`${ui.base}/table/${A.card_id}`);
    const approve = page.getByRole('button', { name: /^approve$/i });
    await approve.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^approve$/i.test(b.textContent.trim()) && !b.disabled), null, { timeout: 30000 });
    await approve.click();
    await sleep(2000);
    const sent = posted.find((p) => p.url.includes(A.approval_id));
    check(sent, 'Approve did not post to /v1/approvals/<id>/respond');
    check(sent.body?.payload_hash === A.hash && sent.body?.head_sha === A.head, `the response is not bound to the hash and head: ${JSON.stringify(sent.body)}`);
    db = await openDbReadonly(home);
    check(db.prepare('SELECT status FROM approvals WHERE id = ?').get(A.approval_id)?.status === 'approved', 'the approval is not approved');
    db.close();

    // 3. Moved head.
    await page.goto(`${ui.base}/table/${B.card_id}`);
    await page.getByText(/changed while you were looking/i).waitFor({ timeout: 20000 });
    const b2 = page.getByRole('button', { name: /^approve$/i });
    check((await b2.count()) === 0 || (await b2.isDisabled()), 'Approve is available on a card whose head moved');
    check(main() === tip, 'main moved after the stale card was shown');

    // 4. Expired.
    await page.goto(`${ui.base}/table/${C.card_id}`);
    await page.getByText(/denied by default/i).waitFor({ timeout: 15000 });
    await page.getByText(/applied by fwd/i).waitFor({ timeout: 5000 });
  } finally {
    await br.close();
    await ui.stop().catch(() => {});
  }
});
