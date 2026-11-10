// Probe for FW-C-091 (the site centres on flows and the Supervisor running them): `pnpm probe ui/flows-home`.
// probe-timeout-s: 180
// Tier 0.
// Supersedes the nav checks of FW-C-067 (probes/ui/clear-nav) and the home checks of FW-C-069 (probes/ui/today).
// Surfaces: packages/web/src/flows/FlowsHome.tsx (the home page, /), packages/web/src/shell/Nav.tsx,
// packages/web/src/shell/routes.ts and packages/web/src/shell/Layout.tsx. Its checks are in
// probes/ui/flows-home.spec.tsx, run with vitest in jsdom against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   TopNav is Flows (/), Needs you (/inbox) and Under the hood (/hood); BottomNav is /, /inbox, /more.
//   routeOf('/flows/<key>') is 'growth' (one flow's page); /growth still opens it; /flows is home; every
//   flow page lights the Flows tab.
//   FlowsHome, inside RouterProvider, PrefsProvider and LiveProvider, shows:
//     a group named "Supervisor ..." saying "<running> of <max_concurrent> running" and its state word;
//     a list named "Flows the Supervisor runs" with a link to /flows/<key> per GET /v1/supervisor flow,
//       the running one saying Working, plus an "Add a flow" item;
//     a list named "Flows" with one item per flow through the stages Find, Draft, You check, Sent, Replies,
//       a held flow showing its reason, each linking to /flows/<key>;
//     a region named "Needs you" with links "<n> drafts ready to send" and "<n> decisions waiting" to /inbox;
//     the open region's progress (region "Region progress").
//   With fwd unreachable the page says it cannot reach fwd and values read Unknown, never 0.
//
// Proves, in order:
//   1. Layout.tsx renders FlowsHome for the home page.
//   2. The component checks pass (6 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/flows-home';

await probe(NAME, async () => {
  // 1. The home page is FlowsHome.
  const home = join(root, 'packages/web/src/flows/FlowsHome.tsx');
  if (!existsSync(home)) missing('packages/web/src/flows/FlowsHome.tsx does not exist (row FW-C-091)');
  const layout = readFileSync(join(root, 'packages/web/src/shell/Layout.tsx'), 'utf8');
  check(/<FlowsHome\b/.test(layout), 'Layout.tsx does not render FlowsHome for the home page');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('flows-home'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/flows-home.spec.tsx')], testTimeout: 30000 },
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
  if (/does not provide an export named 'FlowsHome'|FlowsHome is not/.test(out))
    missing('packages/web/src/flows/FlowsHome.tsx does not export FlowsHome (row FW-C-091)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the Flows home checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+6 passed/.test(out), `expected 6 Flows home checks to pass:\n${out.slice(-400)}`);
});
