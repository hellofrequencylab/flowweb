// Probe for FW-C-026 (two rewards and calm mode): `pnpm probe ui/rewards-calm`. Tier 0.
// probe-timeout-s: 480
// Surfaces: a fixture project driven through the C0 loop (fw run start, the Owner's merge by hand,
// fw ledger close) plus a failing run and a merge slot voided by a push (requestMergeSlot from
// @fw/policy and executeMerge from @fw/daemon, FW-C-011); a real fwd serving the built web bundle
// (probes/lib/web.mjs), paired, driven with Playwright; scripts/check-redlines.mjs.
// The surface this probe expects:
//   The Dawn Log (/) shows the cargo-landed reward ("Landed and proven.") once for each row that
//   merged and whose probe passed on the merged code, and never for a row whose probe failed or whose
//   merge slot was voided. Seen once, it does not fire again for that row in that browser.
//   Calm mode (Settings, "Calm mode") renders the reward with no running animation and no sound: no
//   document animation runs, no AudioContext is created and no media element plays.
//   node scripts/check-redlines.mjs <file>... exits nonzero naming the red line when a file adds a
//   streak counter or a reward based on spend, and exits 0 on the repo's own web sources.
//
// Proves, in order:
//   1. Cargo landed fires once for the merged row and not for the failed or voided ones.
//   2. Calm mode: no animation, no sound.
//   3. The red-line lint refuses a streak counter and a spend-based reward, and passes the repo.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  dbPath,
  fixtureProject,
  fw,
  fwJson,
  git,
  missing,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  root,
  sha256,
  sleep,
  tmpDir,
  writeFiles,
} from '../c0/_lib.mjs';
import { browser, pairedPage, startUi } from '../lib/web.mjs';

const LANDED = 'Landed and proven.';

await probe('ui/rewards-calm', async () => {
  const lint = join(root, 'scripts/check-redlines.mjs');
  if (!existsSync(lint)) missing('scripts/check-redlines.mjs does not exist');
  const requestApproval = await requireExport('policy', 'requestApproval', 'FW-C-010');
  const respondApproval = await requireExport('policy', 'respondApproval', 'FW-C-010');
  const requestMergeSlot = await requireExport('policy', 'requestMergeSlot', 'FW-C-011');
  const executeMerge = await requireExport('daemon', 'executeMerge', 'FW-C-011');
  const LocalBareHost = await requireExport('daemon', 'LocalBareHost', 'FW-C-011');
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  // 3 first: it needs no daemon.
  const dir = tmpDir('redlines');
  const files = {
    'streak.tsx': "import { useState } from 'react';\nexport function Streak() {\n  const [streak] = useState(0);\n  return <p>{streak}-day streak. Keep it going!</p>;\n}\n",
    'spend.tsx': "export function BigSpender({ todayUsd }: { todayUsd: number }) {\n  return todayUsd >= 50 ? <p className=\"reward\">Achievement unlocked: you spent $50 today!</p> : null;\n}\n",
    'clean.tsx': 'export function Done() {\n  return <p>All signed off.</p>;\n}\n',
  };
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  const runLint = (args) => spawnSync(process.execPath, [lint, ...args], { cwd: root, encoding: 'utf8' });
  for (const bad of ['streak.tsx', 'spend.tsx']) {
    const r = runLint([join(dir, bad)]);
    check(r.status !== 0, `check-redlines passed ${bad}`);
  }
  check(runLint([join(dir, 'clean.tsx')]).status === 0, 'check-redlines refused a file with no red line');
  const repo = runLint([]);
  check(repo.status === 0, `check-redlines fails on the repo: ${(repo.stdout + repo.stderr).slice(0, 200)}`);

  // Fixture: one row merged and closed, one failed, one whose slot was voided.
  const proj = fixtureProject({
    rowId: 'FW-C-988',
    extraRows: [
      { id: 'FW-C-989', scenario: 'fail' },
      { id: 'FW-C-990', scenario: 'success' },
    ],
  });
  const home = pipelineHome('rewards');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed');
  const landed = fwJson(['run', 'start', 'FW-C-988', '--adapter', 'fake'], o);
  check(landed.status === 0, `the FW-C-988 run exited ${landed.status}`);
  git(proj.work, 'fetch', '-q', 'origin');
  git(proj.work, 'checkout', '-q', 'main');
  git(proj.work, 'merge', '-q', '--no-ff', '-m', 'merge FW-C-988', `origin/${landed.json.branch}`);
  git(proj.work, 'push', '-q', 'origin', 'main');
  const merged = git(proj.work, 'rev-parse', 'HEAD').trim();
  const close = fwJson(['ledger', 'close', 'FW-C-988', '--merged-sha', merged], o);
  check(close.status === 0, `fw ledger close FW-C-988 exited ${close.status}`);
  fw(['run', 'start', 'FW-C-989', '--adapter', 'fake', '--scenario', 'fail', '--json'], o);
  const v = fwJson(['run', 'start', 'FW-C-990', '--adapter', 'fake'], o);
  check(v.status === 0 && v.json?.pr?.number, `the FW-C-990 run did not open a PR: ${JSON.stringify(v.json).slice(0, 200)}`);

  let db = await openDbReadonly(home);
  const agent = db.prepare("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1").get()?.id;
  const owner = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'owner'").get().value).id;
  db.close();
  const host = new LocalBareHost(proj.remote);
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  try {
    const w = store.writer;
    const evb = `evb_rw${Date.now()}`;
    w.run(
      "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, captured_by) VALUES (?, 'pull_request', ?, '{}', ?, 'kernel')",
      [evb, `#${v.json.pr.number}`, sha256(evb)],
    );
    const hash = sha256(`diff of FW-C-990 at ${v.json.pr.head_sha}`);
    const a = requestApproval(w, {
      action_class: 'merge_main',
      environment: 'production',
      tier: 'L3',
      subject_kind: 'pull_request',
      subject_ref: `#${v.json.pr.number}`,
      payload_hash: hash,
      head_sha: v.json.pr.head_sha,
      evidence_bundle_id: evb,
      requester_agent_id: agent,
      ttl_minutes: 60,
    });
    respondApproval(w, a.approval_id, { decision: 'approve', payload_hash: hash, head_sha: v.json.pr.head_sha, method: 'deck_click' }, { kind: 'owner', id: owner, paired: true });
    const s = requestMergeSlot(w, { approval_id: a.approval_id, pr_number: v.json.pr.number, base: 'main' });
    git(proj.work, 'checkout', '-q', '-B', 'moved', `origin/${v.json.branch}`);
    writeFiles(proj.work, { 'moved.txt': 'pushed after approval\n' });
    git(proj.work, 'add', '.');
    git(proj.work, 'commit', '-qm', 'moved');
    git(proj.work, 'push', '-q', 'origin', `HEAD:${v.json.branch}`);
    const m = await executeMerge({ writer: w, host, grant_id: s.grant_id });
    check(m?.merged === false, 'the moved PR merged');
  } finally {
    store.close();
  }

  const ui = await startUi(home, { env });
  const br = await browser();
  try {
    // 1. Once, only for the landed row.
    let page = await pairedPage(ui, br);
    await page.goto(`${ui.base}/`);
    await page.locator('main').first().waitFor({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    const rewards = page.getByText(LANDED);
    check((await rewards.count()) === 1, `cargo landed shows ${await rewards.count()} times, want once (for FW-C-988 only)`);
    const around = await page.getByRole('status').filter({ hasText: LANDED }).first().innerText();
    check(/FW-C-988/.test(around) && !/FW-C-989|FW-C-990/.test(around), `the reward is not for FW-C-988: ${around.slice(0, 120)}`);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await sleep(1000);
    check((await page.getByText(LANDED).count()) === 0, 'cargo landed fired again for the same row');
    await page.context().close();

    // 2. Calm mode.
    page = await pairedPage(ui, br);
    await page.addInitScript(() => {
      window.__sound = 0;
      const A = window.AudioContext;
      if (A) window.AudioContext = class extends A { constructor(...a) { super(...a); window.__sound++; } };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...a) { window.__sound++; return play.apply(this, a); };
    });
    await page.goto(`${ui.base}/settings`);
    const calm = page.getByLabel(/calm mode/i).first();
    await calm.waitFor({ timeout: 15000 });
    if (!(await calm.isChecked())) await calm.check();
    await page.evaluate(() => localStorage.removeItem('fw.rewards.cargo.seen'));
    await page.goto(`${ui.base}/`);
    await page.getByText(LANDED).first().waitFor({ timeout: 15000 });
    await sleep(500);
    const motion = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    check(motion === 0, `calm mode: ${motion} animations running`);
    check((await page.evaluate(() => window.__sound)) === 0, 'calm mode made a sound');
    check((await page.locator('audio, video').count()) === 0, 'calm mode renders a media element');
  } finally {
    await br.close();
    await ui.stop();
  }
});
