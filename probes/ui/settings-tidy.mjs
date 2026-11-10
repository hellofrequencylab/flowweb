// Probe for FW-C-074 (Settings in a clear order, display preferences folded): `pnpm probe ui/settings-tidy`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/settings/SettingsPage.tsx. The checks are in probes/ui/settings-tidy.spec.tsx,
// run with vitest in jsdom against a fetch stub standing in for fwd (or the hosted /v1), with HOSTED from
// packages/web/src/hosted/auth.ts switched on and off per check.
//
// The surface this probe expects:
//   SettingsPage's level-2 headings run: "Kill switch…" first; on the site then "Accounts and API keys" and
//   "Machines"; then "Session". A button named "Look and feel" comes after Session, aria-expanded="false"
//   at first. The "Calm mode" switch is in view without opening anything, and switching it sets
//   data-calm="on" on the document. Until Look and feel is pressed no "Rewards" or "Single-key shortcuts"
//   switch and no "Dark" radio is rendered. Pressed, it shows the switches "Rewards", "All signed off",
//   "Landed and proven", "Single-key shortcuts" and the radios "Follow system" (Motion), "Dark" (Theme),
//   "Compact" (Table density) and "Arm, then confirm" (Kill switch). The "Policy…" heading and
//   "Read-only here" show without opening anything.
//
// Proves, in order:
//   1. SettingsPage names Look and feel.
//   2. The component checks pass (6 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/settings-tidy';

await probe(NAME, async () => {
  // 1. The fold exists.
  const page = readFileSync(join(root, 'packages/web/src/settings/SettingsPage.tsx'), 'utf8');
  if (!/Look and feel/.test(page)) missing('Settings has no Look and feel fold (row FW-C-074)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('settings-tidy'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/settings-tidy.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the Settings checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+6 passed/.test(out), `expected 6 Settings checks to pass:\n${out.slice(-400)}`);
});
