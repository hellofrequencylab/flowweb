// Probe for FW-C-115 (every flow's controls card on the Flows page is built the same way): `pnpm probe ui/flow-cards`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/FlowControls.tsx, packages/web/src/ui-kit/flow.css and
// packages/web/src/ui-kit/base.css. The component checks are in probes/ui/flow-cards.spec.tsx, run with vitest
// in jsdom against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   base.css styles input[type="time"] with the same shared rule as select and the text inputs;
//   flow.css gives .flow-card (the fieldset that is one flow's card) real padding, and leaves the list items
//     around the cards unpadded, so the card's padding, state edge and live sweep sit on one box;
//   in the rendered controls every flow's group (a fieldset named after the flow) carries the class flow-card;
//   its Turn on/off and Run now buttons share one size (btn-small) and neither is a bare link (btn-quiet);
//   its dial is a segmented control whose radios are named exactly Draft, Copilot and Autopilot, with the
//     chosen stop's one-line hint below it;
//   the long "how to set up a sender" explanation shows once for the whole list, not once per card.
//
// Proves, in order:
//   1. The time input shares the input style.
//   2. The card box carries the padding.
//   3. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/flow-cards';
const SRC = join(root, 'packages/web/src');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sels: m[1].split(',').map((x) => x.trim()),
    decl: m[2],
  }));

await probe(NAME, async () => {
  // 1. The time input shares the input style.
  const base = rules(strip(readFileSync(join(SRC, 'ui-kit/base.css'), 'utf8')));
  const shared = base.find((r) => r.sels.includes('select') && r.sels.includes('input[type="text"]') && /min-height/.test(r.decl));
  check(shared, 'base.css has no shared rule for select and text inputs');
  check(
    shared.sels.includes('input[type="time"]'),
    'base.css styles select and text inputs but not input[type="time"], so the morning run time looks different (row FW-C-115)',
  );

  // 2. The card box carries the padding.
  const flow = rules(strip(readFileSync(join(SRC, 'ui-kit/flow.css'), 'utf8')));
  const pad = (sel) =>
    flow
      .filter((r) => r.sels.includes(sel))
      .flatMap((r) => [...r.decl.matchAll(/(?:^|;|\s)padding\s*:\s*([^;]+);/g)].map((m) => m[1].trim()));
  const card = pad('.flow-card');
  check(
    card.length > 0 && card.every((v) => !/^0(px)?$/.test(v)),
    `flow.css gives .flow-card no padding (${JSON.stringify(card)}), so its text runs to its edge (row FW-C-115)`,
  );
  const item = [...pad('.flow-cards > li'), ...pad('.flow-cards > li:last-child')];
  check(
    item.length > 0 && item.every((v) => /^0(px)?$/.test(v)),
    `flow.css pads the list items around the cards (${JSON.stringify(item)}); the card itself should carry it`,
  );

  // 3. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('flow-cards'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/flow-cards.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the flow card checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 flow card checks to pass:\n${out.slice(-400)}`);
});
