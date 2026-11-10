// Probe for FW-C-067 (one clear nav: Today, Inbox, Growth, Under the hood): `pnpm probe ui/clear-nav`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/shell/Nav.tsx (TopNav, BottomNav, MorePage), packages/web/src/shell/routes.ts
// (routeOf), packages/web/src/hood (HoodTabs) and packages/web/src/shell/Layout.tsx. Its checks are in
// probes/ui/clear-nav.spec.tsx, run with vitest in jsdom against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   The top nav named "Main" links, in order, Today (/), Inbox (/inbox), Growth (/growth) and Under the hood
//   (/hood), and none of the old words Console, Sign-offs, Logs, Runs, Spend or Flows. Old addresses still
//   work and light the new tab: /table is Inbox, /flows is Growth, /ledger, /runs, /spend and /projects are
//   Under the hood. The phone tab bar is Today, Inbox, Growth and More; More links /hood, /setup, /settings.
//   HoodTabs is a nav named "Under the hood" with Logs (/ledger), Runs (/runs), Projects (/projects) and
//   Spend (/spend), the current one aria-current="page". routeOf(path) names the one page each address shows
//   (null for none), and Layout picks its page with routeOf.
//
// Proves, in order:
//   1. Layout picks its page with routeOf.
//   2. The component checks pass (5 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/clear-nav';

await probe(NAME, async () => {
  // 1. Layout routes through routeOf.
  const layout = readFileSync(join(root, 'packages/web/src/shell/Layout.tsx'), 'utf8');
  if (!/\brouteOf\(/.test(layout)) missing('Layout does not pick its page with routeOf (row FW-C-067)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('clear-nav'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/clear-nav.spec.tsx')], testTimeout: 30000 },
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
  if (/Failed to resolve import|Cannot find module|does not provide an export named/.test(out))
    missing('the nav surface (shell/routes.ts routeOf, hood HoodTabs) does not exist yet (row FW-C-067)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the clear nav checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+5 passed/.test(out), `expected 5 clear nav checks to pass:\n${out.slice(-400)}`);
});
