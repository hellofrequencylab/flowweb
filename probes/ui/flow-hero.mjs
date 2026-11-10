// Probe for FW-C-093 (each flow's page opens with where that flow is): `pnpm probe ui/flow-hero`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/FlowHero.tsx, mounted by packages/web/src/flows/ActivationPage.tsx with the
// flow key from /flows/<key> (its `flow` prop). Checks are in probes/ui/flow-hero.spec.tsx, run with
// vitest in jsdom against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   FlowHero({ flowKey }) shows a region named "Where this flow is" with a link "All flows" to /, and the
//   flow GET /v1/supervisor lists under that key: its name, state word, dial word, reason, the five stage
//   names (Find, Draft, You check, Sent, Replies), and draft counts from its drafts ("<n> to check"). No stage
//   shows a count FlowWeb does not have (no "x0" for finds). With fwd unreachable the flow reads Unknown.
//
// Proves, in order:
//   1. packages/web/src/flows/FlowHero.tsx exists and ActivationPage renders it.
//   2. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/flow-hero';

await probe(NAME, async () => {
  // 1. The hero exists and the flow page renders it.
  const hero = join(root, 'packages/web/src/flows/FlowHero.tsx');
  if (!existsSync(hero)) missing('packages/web/src/flows/FlowHero.tsx does not exist (row FW-C-093)');
  const page = readFileSync(join(root, 'packages/web/src/flows/ActivationPage.tsx'), 'utf8');
  check(/<FlowHero\b[^>]*flowKey=\{flow\b/.test(page), 'ActivationPage.tsx does not render FlowHero for the flow in the address');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('flow-hero'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/flow-hero.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the flow page checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 flow page checks to pass:\n${out.slice(-400)}`);
});
