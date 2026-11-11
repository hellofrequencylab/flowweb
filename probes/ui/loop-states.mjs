// Probe for FW-C-098 (every meter, node and line of a flow shows its loop state, and says what it is on
// click): `pnpm probe ui/loop-states`. Tier 0.
// Surfaces: packages/web/src/ui-kit/loop.tsx (Loop, LoopProvider, useLoopTarget), flowLoop in
// packages/web/src/flows/flowState.ts, FlowRing and Gauge (src/ui-kit/flow.tsx), FlowHero, RegionPath and
// MeasureDials, the flow page (src/flows/ActivationPage.tsx) and src/ui-kit/flow.css. The component checks
// are in probes/ui/loop-states.spec.tsx, run with vitest in jsdom against a fetch stub.
//
// The Owner's ask (2026-11-10): show every active loop as constantly flowing when it is all good; a process
// working now at full brightness and motion; hooked up but between cycles dimmer and slower; a node waiting
// for a cycle still but pulsing; anything broken or incomplete in warning tones; and any node or connection
// opens what it is on click.
//
// Proves, in order:
//   1. The styles: four loop states, working and connected lines move at different speeds, waiting pulses,
//      broken uses the warning tone and has no motion, and reduced motion and calm mode stop all of it.
//   2. The flow page puts the states on its figures, regions and dials, inside one LoopProvider.
//   3. The components: the Supervisor maps to four states, the hero ring's five stages and five lines carry
//      them, meters and region lines carry them, and a click or Enter opens what a piece is.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/loop-states';
const read = (p) => {
  try {
    return readFileSync(join(root, p), 'utf8');
  } catch {
    return null;
  }
};

await probe(NAME, async () => {
  // ---- 1. the styles ------------------------------------------------------------------------------
  const loopTs = read('packages/web/src/ui-kit/loop.tsx');
  if (loopTs === null) missing('packages/web/src/ui-kit/loop.tsx does not exist (row FW-C-098)');
  const css = read('packages/web/src/ui-kit/flow.css') ?? '';
  const rule = (sel) => {
    // A rule that starts right after another ends, so ".a .b" never matches the tail of ".x .b,\n.a .b".
    const i = css.indexOf(`}\n${sel} {`);
    if (i < 0) return null;
    return css.slice(i + 1, css.indexOf('}', i + 1));
  };
  for (const s of ['working', 'connected', 'waiting', 'broken'])
    check(rule(`.loop-${s}`), `flow.css has no .loop-${s} rule`);
  check(/var\(--caution-fg\)/.test(rule('.loop-broken') ?? ''), '.loop-broken does not use the warning tone');
  const speed = (sel) => {
    const r = rule(sel) ?? '';
    const m = /animation(?:-duration)?:[^;]*?([\d.]+)s/.exec(r);
    return m ? Number(m[1]) : null;
  };
  const fast = speed('.loop-working .loop-line,\n.loop-connected .loop-line');
  const slow = speed('.loop-connected .loop-line');
  check(fast && slow && slow > fast, `working lines must move faster than connected ones (got ${fast}s and ${slow}s)`);
  check(/animation:\s*fw-soft-pulse/.test(rule('.loop-waiting .loop-line') ?? ''), 'waiting lines do not pulse');
  check(!/animation/.test(rule('.loop-broken .loop-line') ?? 'animation'), 'broken lines must not move');
  const base = read('packages/web/src/ui-kit/base.css') ?? '';
  check(
    /prefers-reduced-motion: reduce\)\s*\{\s*\*,[\s\S]*?animation: none !important/.test(base) &&
      /data-calm="on"\] \*,[\s\S]*?animation: none !important/.test(base),
    'reduced motion and calm mode must stop every animation (base.css)',
  );

  // ---- 2. the flow page ----------------------------------------------------------------------------
  const page = read('packages/web/src/flows/ActivationPage.tsx') ?? '';
  check(/<LoopProvider>/.test(page), 'the flow page is not wrapped in <LoopProvider>');
  check(/<RegionPath[^>]*\bloop=/.test(page), 'the flow page does not give RegionPath the loop state');
  check(/<MeasureDials[^>]*\bloop=/.test(page), "the flow page does not give each region's dials the loop state");
  check((page.match(/<Gauge\s+loop=/g) ?? []).length >= 2, 'the flow page figures do not give their meters the loop state');
  check(!/Lines move only while a cycle is working/.test(page), 'the flow page still says lines move only while a cycle works');

  // ---- 3. the components ---------------------------------------------------------------------------
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('loop-states'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/loop-states.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the loop state checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 loop state checks to pass:\n${out.slice(-400)}`);
});
