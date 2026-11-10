// Probe for FW-C-090 (Terms of Service and Privacy Policy pages on flowweb.app): `pnpm probe ui/legal-pages`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/legal/Legal.tsx, packages/web/src/shell/App.tsx and packages/web/src/home/HomePage.tsx.
// The checks are in probes/ui/legal-pages.spec.tsx, run with vitest in jsdom with packages/web/src/hosted/auth.ts
// stood in by spies, so nothing reaches an auth server.
//
// The surface this probe expects:
//   legalRouteOf(path) returns 'terms' for /terms and /terms/, 'privacy' for /privacy and /privacy/, null otherwise.
//   <LegalPage page="terms" | "privacy" /> renders one h1 (Terms of Service / Privacy Policy), a "Last updated" line,
//   a mailto: link, a link to the other page (href /privacy or /terms) and a link home (href /), and no em dash.
//   The privacy page mentions Google, name, email, Supabase, business account(s), drafts and delete.
//   The terms page mentions drafts and that you send, and links to /privacy.
//   <HomePage /> has links to /terms and /privacy.
//
// Proves, in order:
//   1. Legal.tsx exists and App.tsx renders LegalPage.
//   2. The component checks pass (6 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/legal-pages';

await probe(NAME, async () => {
  // 1. The pages exist and the app shows them.
  if (!existsSync(join(root, 'packages/web/src/legal/Legal.tsx')))
    missing('packages/web/src/legal/Legal.tsx does not exist (row FW-C-090)');
  const app = readFileSync(join(root, 'packages/web/src/shell/App.tsx'), 'utf8');
  check(/<LegalPage\b/.test(app), 'packages/web/src/shell/App.tsx does not render <LegalPage> (row FW-C-090)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('legal-pages'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/legal-pages.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the terms and privacy checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+6 passed/.test(out), `expected 6 terms and privacy checks to pass:\n${out.slice(-400)}`);
});
