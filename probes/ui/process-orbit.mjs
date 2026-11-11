// Probe for FW-C-099 (a flow's other processes show as rings inside its outreach ring, each with its loop
// state, and each ring, node, line and the hub opens what it is): `pnpm probe ui/process-orbit`. Tier 0.
// Surfaces: packages/web/src/ui-kit/orbit.tsx (OrbitRings, OrbitLegend), packages/web/src/flows/processes.ts
// (learningRing, regionRing, spendRing), FlowRing's inner rings (src/ui-kit/flow.tsx), FlowHero and
// src/ui-kit/flow.css. The component checks are in probes/ui/process-orbit.spec.tsx, run with vitest in jsdom
// against a fetch stub.
//
// The Owner's ask (2026-11-11): do one more design pass with the design system, show more rings for more
// processes, and add a compact accent picker for the site. A flow is more than its outreach cycle: it learns
// each week, works regions in order, and spends against a cap. Each of those is a ring, from fwd's own reads,
// never a made-up state.
//
// Proves, in order:
//   1. The styles: orbit nodes and the hub take the loop states (working glows, waiting pulses), and the
//      legend draws a ring per process.
//   2. The hero puts the inner rings inside its outreach ring and names every ring in a legend.
//   3. The accent: the Owner picks it in Settings (teal by default); loops, glows and live edges take it,
//      and status colours never change.
//   4. The components: learning, regions and spend map fwd's reads to loop states, an unanswered read waits
//      and says Unknown, the hero draws the inner rings, and a click on a ring, node or the hub says what it is.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/process-orbit';
const read = (p) => {
  try {
    return readFileSync(join(root, p), 'utf8');
  } catch {
    return null;
  }
};

await probe(NAME, async () => {
  // ---- 1. the styles ------------------------------------------------------------------------------
  if (read('packages/web/src/ui-kit/orbit.tsx') === null)
    missing('packages/web/src/ui-kit/orbit.tsx does not exist (row FW-C-099)');
  const css = read('packages/web/src/ui-kit/flow.css') ?? '';
  check(/\n\.orbit-track \{/.test(css), 'flow.css has no .orbit-track rule');
  check(
    /\.orbit-node\.loop-working \.orbit-dot[\s\S]{0,120}\{[^}]*drop-shadow/.test(css),
    'a working orbit node does not glow',
  );
  check(
    /\.orbit-node\.loop-waiting \.orbit-dot[\s\S]{0,160}\{[^}]*fw-soft-pulse/.test(css),
    'a waiting orbit node does not pulse',
  );
  check(/\n\.orbit-legend \{/.test(css), 'flow.css has no .orbit-legend rule');
  const tokens = read('packages/web/src/ui-kit/tokens.css') ?? '';
  check(/--accent: var\(--flow-teal\)/.test(tokens), 'tokens.css has no --accent that defaults to teal');
  for (const a of ['slate', 'indigo', 'olive', 'clay'])
    check(new RegExp(`data-accent="${a}"\\] \\{\\s*--accent: var\\(--flow-${a}\\)`).test(tokens), `tokens.css has no ${a} accent`);
  check(/--loop-c: var\(--accent\)/.test(css), 'the loop states do not take the accent');
  check(!/var\(--flow-teal\)/.test(css), 'flow.css still hard-codes teal instead of the accent');

  // ---- 2. the hero ---------------------------------------------------------------------------------
  const hero = read('packages/web/src/flows/FlowHero.tsx') ?? '';
  check(/inner=\{<OrbitRings/.test(hero), 'FlowHero does not draw inner rings inside its ring');
  check(/<OrbitLegend/.test(hero), 'FlowHero does not name its rings in a legend');
  for (const fn of ['learningRing', 'regionRing', 'spendRing'])
    check(new RegExp(`${fn}\\(`).test(hero), `FlowHero does not draw the ${fn} process`);

  // ---- 3. and 4. the components ---------------------------------------------------------------------------
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('process-orbit'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/process-orbit.spec.tsx')], testTimeout: 30000 },
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
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 10);
  check(r.status === 0, `the process orbit checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 process orbit checks to pass:\n${out.slice(-400)}`);
});
