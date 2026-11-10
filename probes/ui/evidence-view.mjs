// Probe for FW-C-022 (evidence view): `pnpm probe ui/evidence-view`. Tier 0.
// probe-timeout-s: 420
// Surfaces: a fixture project with one fake-vendor run (which writes an evidence bundle); requestApproval
// (@fw/policy) and createDecisionItem (@fw/ledger) with the Writer of the Store port for a red-scan
// card; a real fwd serving the built web bundle (probes/lib/web.mjs), paired, driven with Playwright;
// GET /v1/evidence-bundles/{id} and /diff; the database read-only.
// The surface this probe expects:
//   /evidence/<bundle id> lists every body.automated_evidence item with its status word (pass, fail,
//   warn or skipped), its ran_at as a <time datetime="<ran_at>"> element, and, when it has an
//   artifact_ref, a link to it.
//   The diff view on that page shows the exact lines of GET /v1/evidence-bundles/{id}/diff, whose
//   sha256 is body.intent_payload.payload_hash, and shows that hash.
//   An approve card whose bundle has scan_red = 1 keeps Approve disabled and says why, naming the scan.
//
// Proves, in order:
//   1. Each automated evidence item shows its status, its ran_at, and a link to its artifact.
//   2. The diff view shows the hunks that hash to the payload hash.
//   3. A red-scan bundle disables Approve and says why.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  dbPath,
  fixtureProject,
  fw,
  fwJson,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  root,
  sha256,
} from '../c0/_lib.mjs';
import { api } from '../lib/fwd.mjs';
import { browser, pairedPage, startUi } from '../lib/web.mjs';

await probe('ui/evidence-view', async () => {
  const requestApproval = await requireExport('policy', 'requestApproval', 'FW-C-010');
  const createDecisionItem = await requireExport('ledger', 'createDecisionItem', 'WS-P1-024');
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-984' });
  const home = pipelineHome('evidence');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed');
  const run = fwJson(['run', 'start', 'FW-C-984', '--adapter', 'fake'], o);
  check(run.status === 0, `fw run start exited ${run.status}`);
  let db = await openDbReadonly(home);
  const evb = db.prepare("SELECT id, body FROM evidence_bundles WHERE body LIKE '%automated_evidence%' ORDER BY created_at DESC LIMIT 1").get();
  const agent = db.prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1").get()?.id;
  const projectId = db.prepare("SELECT project_id FROM ledger_rows WHERE id = 'lr_FWC984'").get()?.project_id;
  db.close();
  check(evb, 'the run wrote no evidence bundle with automated_evidence');
  const body = JSON.parse(evb.body);

  // A red-scan bundle and an approve card on it.
  const red = `evb_red${Date.now()}`;
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  let redCard;
  try {
    const w = store.writer;
    w.run(
      "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, scan_red, captured_by) VALUES (?, 'pull_request', '#1', ?, ?, 1, 'kernel')",
      [red, JSON.stringify({ ...body, id: red, scan_red: true }), sha256(red)],
    );
    const hash = body.intent_payload?.payload_hash ?? sha256(red);
    const a = requestApproval(w, {
      action_class: 'merge_main',
      environment: 'production',
      tier: 'L3',
      subject_kind: 'pull_request',
      subject_ref: '#1',
      payload_hash: hash,
      head_sha: 'b'.repeat(40),
      evidence_bundle_id: red,
      requester_agent_id: agent,
      ttl_minutes: 60,
    });
    redCard = createDecisionItem(w, {
      variant: 'approve',
      project: projectId,
      ask: 'Merge the red-scan change?',
      approval_id: a.approval_id,
      evidence_bundle_id: red,
      headline: 'A change whose scan is red.',
      payload_preview: { format: 'diff', excerpt: 'red', full_ref: '#1', payload_hash: hash },
      risk: { blast_radius: 'one file', reversible: true, scan_status: 'red' },
      default_on_timeout: 'deny',
      deadline: new Date(Date.now() + 3600000).toISOString(),
    }).card_id;
  } finally {
    store.close();
  }

  const ui = await startUi(home, { env });
  const br = await browser();
  try {
    const page = await pairedPage(ui, br);
    await page.goto(`${ui.base}/evidence/${evb.id}`);
    await page.locator('main').first().waitFor({ timeout: 15000 });
    await page.waitForLoadState('networkidle');

    // 1. Items.
    const items = body.automated_evidence ?? [];
    check(items.length > 0, 'the bundle has no automated_evidence');
    for (const it of items) {
      const t = page.locator(`time[datetime="${it.ran_at}"]`);
      check((await t.count()) >= 1, `${it.name}: its ran_at ${it.ran_at} is not shown as a <time datetime>`);
      const row = page.locator('li, tr, article, section').filter({ hasText: it.name }).filter({ has: t }).first();
      check((await row.count()) === 1, `${it.name} is not listed with its ran_at`);
      check(new RegExp(`\\b${it.status}\\b`, 'i').test(await row.innerText()), `${it.name} does not show its status ${it.status}`);
      if (it.artifact_ref) check((await row.locator('a[href]').count()) >= 1, `${it.name} does not link its artifact`);
    }

    // 2. Diff.
    const diff = await api(ui.port, 'GET', `/v1/evidence-bundles/${evb.id}/diff`, { auth: ui.token });
    check(diff.status === 200, `GET .../diff answered ${diff.status}`);
    const h = createHash('sha256').update(diff.text).digest('hex');
    check(h === body.intent_payload?.payload_hash, 'the served diff does not hash to intent_payload.payload_hash');
    const text = await page.locator('main').innerText();
    check(text.includes(h) || text.includes(h.slice(0, 12)), 'the evidence view does not show the payload hash');
    const lines = diff.text.split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l) && l.slice(1).trim().length > 0);
    const absent = lines.filter((l) => !text.includes(l.slice(1).trim()));
    check(absent.length === 0, `diff lines not shown: ${absent.slice(0, 3).join(' | ')}`);

    // 3. Red scan.
    await page.goto(`${ui.base}/table/${redCard}`);
    const approve = page.getByRole('button', { name: /^approve$/i });
    await approve.waitFor({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    check(await approve.isDisabled(), 'Approve is enabled on a red-scan bundle');
    check(/scan/i.test(await page.locator('main').innerText()), 'the card does not say the scan is why Approve is disabled');
  } finally {
    await br.close();
    await ui.stop();
  }
});
