// Probe for FW-C-070 (the Flows page as a daily growth view): `pnpm probe flows/growth-page`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/ActivationPage.tsx (the /flows page), FlowControls and AdminPage exported
// from packages/web/src/flows. The component checks are in probes/flows/growth-page.spec.tsx, run with vitest
// in jsdom against a fetch stub standing in for fwd, as probes/flows/site-controls.mjs does.
//
// The surface this probe expects:
//   packages/web/src/flows/SupervisorPanel.tsx and packages/web/src/flows/FlowPage.tsx do not exist, and the
//     Flows page names neither SupervisorPanel nor FlowAdmin.
//   The Flows page links to /growth/admin. packages/web/src/flows exports AdminPage(), which reads
//     GET /v1/flows/neighborhood-activation and shows the panels Upload leads, Upload metrics,
//     Open the next region, Activation targets, Edit raw config and Admin log.
//   The Flows page has a <ChapterHead ... title="Paid ads" ...> and <PaidAdsPanel appears in that chapter only
//     (between it and the next ChapterHead), not in the Reach chapter.
//   Inside FlowControls each flow is a group named after the flow holding: its gate word (the Supervisor's
//     one word for why it is or is not running), the Turn off / Turn on button, Run <name> now, and the
//     "Dial for <name>" radiogroup. With the kill switch engaged the row's word is "Stopped by the kill
//     switch". A spend fwd does not know reads Unknown, never $0.00.
//
// Proves, in order:
//   1. The duplicate Supervisor panel and the unrouted FlowPage are gone.
//   2. Admin is off the Flows page and linked.
//   3. Paid ads is its own chapter.
//   4. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/growth-page';
const FLOWS = join(root, 'packages/web/src/flows');

await probe(NAME, async () => {
  const page = readFileSync(join(FLOWS, 'ActivationPage.tsx'), 'utf8');

  // 1. One controls table, no unrouted page.
  check(!existsSync(join(FLOWS, 'SupervisorPanel.tsx')), 'flows/SupervisorPanel.tsx still exists (row FW-C-070)');
  check(!/SupervisorPanel/.test(page), 'the Flows page still names SupervisorPanel');
  check(!existsSync(join(FLOWS, 'FlowPage.tsx')), 'flows/FlowPage.tsx still exists');

  // 2. Admin lives on its own page.
  check(!/<FlowAdmin\b/.test(page), 'the Flows page still renders <FlowAdmin>');
  check(/["'`]\/growth\/admin["'`]/.test(page), 'the Flows page does not link to /growth/admin');
  check(existsSync(join(FLOWS, 'AdminPage.tsx')), 'flows/AdminPage.tsx does not exist');

  // 3. Paid ads is a chapter of its own.
  const chapters = page.split(/<ChapterHead\b/).slice(1);
  const ads = chapters.filter((c) => /title=["'{`]+Paid ads/.test(c));
  check(ads.length === 1, 'the Flows page has no chapter titled "Paid ads"');
  check(ads.length === 1 && /<PaidAdsPanel\b/.test(ads[0]), 'PaidAdsPanel is not inside the Paid ads chapter');
  check(
    chapters.filter((c) => /<PaidAdsPanel\b/.test(c)).length === 1,
    'PaidAdsPanel is rendered in more than one chapter (still under Reach?)',
  );

  // 4. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('growth-page'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/growth-page.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (/does not provide an export named 'AdminPage'|AdminPage is not/.test(out))
    missing('packages/web/src/flows does not export AdminPage (row FW-C-070)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the growth page checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 growth page checks to pass:\n${out.slice(-400)}`);
});
