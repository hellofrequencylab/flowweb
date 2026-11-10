// Probe for FW-C-066 (the drafts inbox on the Flows page): `pnpm probe flows/drafts-inbox`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/ActivationPage.tsx (the /flows page) and the DraftsInbox component
// exported from packages/web/src/flows. Its checks are in probes/flows/drafts-inbox.spec.tsx, run with
// vitest in jsdom against a fetch stub standing in for fwd, as probes/flows/site-controls.mjs does.
//
// The surface this probe expects:
//   packages/web/src/flows exports DraftsInbox({ flow }), and ActivationPage renders <DraftsInbox.
//   Inside a LiveProvider it reads GET /v1/supervisor/flows/{flow}/drafts and shows:
//     a listbox named "All drafts" with one option per draft (every status), each option's name holding the
//       draft's subject and one state word: Ready, Has blanks, Sent, Replied, Said no, Approved or Rejected;
//     a region named "Draft viewer" with the selected draft's full body.
//   The newest ready draft is selected first. Clicking an option, or ArrowDown on the listbox, selects
//   another (aria-selected) and the viewer shows its body. The viewer's "Tell AI how to rewrite this draft"
//   box and its Rewrite button post /v1/supervisor/flows/{flow}/drafts/{id}/rewrite for the selected draft.
//
// Proves, in order:
//   1. The Flows page renders DraftsInbox.
//   2. The component checks pass (5 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/drafts-inbox';

await probe(NAME, async () => {
  // 1. The Flows page renders the inbox.
  const page = readFileSync(join(root, 'packages/web/src/flows/ActivationPage.tsx'), 'utf8');
  if (!/<DraftsInbox\b/.test(page)) missing('the Flows page does not render <DraftsInbox> (row FW-C-066)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('drafts-inbox'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/drafts-inbox.spec.tsx')], testTimeout: 30000 },
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
  if (/does not provide an export named 'DraftsInbox'|DraftsInbox is not/.test(out))
    missing('packages/web/src/flows does not export DraftsInbox (row FW-C-066)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the drafts inbox checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+5 passed/.test(out), `expected 5 drafts inbox checks to pass:\n${out.slice(-400)}`);
});
