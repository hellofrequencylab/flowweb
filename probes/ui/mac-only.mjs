// Probe for FW-C-073 (buttons that only work on the Owner's Mac say so on flowweb.app): `pnpm probe ui/mac-only`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/ui-kit/Button.tsx, packages/web/src/shell/KillSwitch.tsx,
// packages/web/src/settings/SettingsPage.tsx and packages/web/src/evidence/EvidencePage.tsx. The checks are in
// probes/ui/mac-only.spec.tsx, run with vitest in jsdom against a fetch stub standing in for fwd (or the hosted
// /v1), with HOSTED from packages/web/src/hosted/auth.ts switched on and off per check.
//
// The surface this probe expects:
//   <Button macOnly> on the site (HOSTED) is disabled, and its accessible description holds "Only on your Mac";
//   pressing it calls nothing. Off the site it is an ordinary enabled button.
//   KillControl on the site: "Stop everything" is disabled, described by "Only on your Mac"; when stopped,
//   "Release…" is disabled the same way. KillPill on the site never starts a hold: no POST /v1/kill-switch.
//   SettingsPage on the site shows the kill switch with Stop everything locked the same way.
//   EvidencePage on the site: the region "The change" says "Only on your Mac" and no GET of .../diff is made.
//   Off the site (arm mode) Stop everything, then Confirm, still posts /v1/kill-switch.
//
// Proves, in order:
//   1. Button.tsx declares a macOnly prop.
//   2. The component checks pass (7 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/mac-only';

await probe(NAME, async () => {
  // 1. The Button knows about Mac-only actions.
  const button = readFileSync(join(root, 'packages/web/src/ui-kit/Button.tsx'), 'utf8');
  if (!/\bmacOnly\b/.test(button)) missing('packages/web/src/ui-kit/Button.tsx has no macOnly prop (row FW-C-073)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('mac-only'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/mac-only.spec.tsx')], testTimeout: 30000 },
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
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the Mac-only checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 Mac-only checks to pass:\n${out.slice(-400)}`);
});
