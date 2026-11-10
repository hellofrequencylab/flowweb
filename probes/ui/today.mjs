// Probe for FW-C-069 (the home page is a Today summary): `pnpm probe ui/today`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/dawn/DawnLog.tsx (the home page, /) and packages/web/src/dawn/BuildOverview.tsx.
// Its checks are in probes/ui/today.spec.tsx, run with vitest in jsdom against a fetch stub standing in
// for fwd, as probes/flows/drafts-inbox.mjs does.
//
// The surface this probe expects:
//   DawnLog, inside RouterProvider, PrefsProvider and LiveProvider, shows a region named "Today" with:
//     a link whose text says how many drafts are ready to send ("2 drafts ready to send"), counted over
//       every flow GET /v1/supervisor lists, from GET /v1/supervisor/flows/{key}/drafts (waiting for the
//       Owner, no blank {{slot}}, not sent), and a link saying how many decisions are waiting
//       ("3 decisions waiting", the status open_cards); both point at /inbox, /table or /flows;
//     a region named "Region progress" with the open (active) region of GET /v1/flows/neighborhood-activation
//       and each of its measures as "<value> of <target>", or Unknown when the region has no measures;
//     a list named "Flows" with one item per supervisor flow: its name, Running, Ready or Held, and the
//       reason when held.
//   A problem (kill switch engaged, budget pause) is an alert placed before the Today region. With fwd
//   unreachable the page says it cannot reach fwd and the counts read Unknown, never 0.
//   The digest headline shows once. The home page no longer has the build-tracker sections (Your lanes,
//   Every change in flight, Landed since, Merged, watching, Integrity); BuildOverview, exported from
//   dawn/BuildOverview.tsx, shows them.
//
// Proves, in order:
//   1. dawn/BuildOverview.tsx exports BuildOverview and DawnLog does not render the build tracker itself.
//   2. The component checks pass (6 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/today';

await probe(NAME, async () => {
  // 1. The build tracker moved out of the home page.
  const bo = join(root, 'packages/web/src/dawn/BuildOverview.tsx');
  if (!existsSync(bo)) missing('packages/web/src/dawn/BuildOverview.tsx does not exist (row FW-C-069)');
  check(
    /export\s+function\s+BuildOverview\b/.test(readFileSync(bo, 'utf8')),
    'dawn/BuildOverview.tsx does not export function BuildOverview',
  );
  const home = readFileSync(join(root, 'packages/web/src/dawn/DawnLog.tsx'), 'utf8');
  check(!/<LaneOrbits\b|<FlowBoard\b/.test(home), 'DawnLog still renders the lanes or the changes in flight');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('today'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/today.spec.tsx')], testTimeout: 30000 },
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
  if (/does not provide an export named 'BuildOverview'|BuildOverview is not/.test(out))
    missing('packages/web/src/dawn/BuildOverview.tsx does not export BuildOverview (row FW-C-069)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the Today checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+6 passed/.test(out), `expected 6 Today checks to pass:\n${out.slice(-400)}`);
});
