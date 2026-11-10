// Probe for FW-C-077 (a clean drafts editor: no sand, no avatars, one action bar): `pnpm probe flows/draft-editor-clean`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/DraftsInbox.tsx and DraftEditor.tsx (the drafts inbox, FW-C-066, with the
// AI assistant, FW-C-076) and their styles in packages/web/src/ui-kit/flow.css. The component checks are in
// probes/flows/draft-editor-clean.spec.tsx, run with vitest in jsdom against a fetch stub standing in for fwd,
// as probes/flows/drafts-inbox.mjs does.
//
// The surface this probe expects:
//   no initials avatar (GroupBadge or any *avatar* element) in the "All drafts" listbox or the "Draft viewer"
//     region, and each option's text starts with who the draft is for;
//   in the viewer, the subject as a heading and a toolbar named "Draft actions" placed before the message
//     body, holding Copy, Edit, Approve and Reject for a ready draft, and Save and Cancel while editing;
//   in flow.css, the rules for .inbox, .inbox-list, .inbox-item.is-on and .draft-body name no sand surface
//     (--surface-sunken, --surface-page, --surface-soft), and .inbox-item.is-on has no card shadow.
//
// Proves, in order:
//   1. The inbox styles use no sand surface and the selected row is not a raised card.
//   2. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/draft-editor-clean';
const SAND = /--surface-(sunken|page|soft)\b/;
const TARGETS = ['.inbox', '.inbox-list', '.inbox-item.is-on', '.draft-body'];

await probe(NAME, async () => {
  // 1. The styles.
  const css = readFileSync(join(root, 'packages/web/src/ui-kit/flow.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/^\.flows-page\s+/, ''));
    const decl = m[2];
    for (const t of TARGETS) {
      if (!sels.includes(t)) continue;
      if (SAND.test(decl)) bad.push(`${t} uses a sand surface: ${decl.match(SAND)[0]}`);
      if (t === '.inbox-item.is-on' && /box-shadow\s*:\s*var\(--shadow/.test(decl))
        bad.push('.inbox-item.is-on is still a raised card (box-shadow var(--shadow-*))');
    }
  }
  check(bad.length === 0, `the drafts inbox still has the sand look (row FW-C-077):\n${bad.join('\n')}`);

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('draft-editor-clean'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/draft-editor-clean.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the clean editor checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 clean editor checks to pass:\n${out.slice(-400)}`);
});
