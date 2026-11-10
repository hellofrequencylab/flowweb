// Probe for FW-C-076 (an AI assistant on each draft, a back-and-forth with every version kept):
// `pnpm probe flows/draft-assistant`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/DraftAssistant.tsx, rendered by DraftEditor in the drafts inbox
// (FW-C-066). Its checks are in probes/flows/draft-assistant.spec.tsx, run with vitest in jsdom against a
// fetch stub standing in for fwd, as probes/flows/drafts-inbox.mjs does. No fwd route changes: every
// rewrite is the existing POST /v1/supervisor/flows/{flow}/drafts/{id}/rewrite (FW-C-051), which answers a
// proposal and never changes the draft.
//
// The surface this probe expects, inside the drafts inbox's "Draft viewer" region:
//   a log named "AI conversation" holding each instruction the Owner gave and the AI's version (or its error);
//   the "Tell AI how to rewrite this draft" box and its Rewrite button; each rewrite goes into the editor's
//   Subject and Message boxes unsaved, and the next instruction rewrites what is in them (the latest version);
//   an "Undo last rewrite" button, a "Back to the original" button, and a "Use this version" button on each
//   AI version; the conversation is kept for the browser tab when the Owner opens another draft and comes back;
//   only Save posts .../edit.
//
// Proves, in order:
//   1. DraftEditor renders <DraftAssistant.
//   2. The component checks pass (7 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/draft-assistant';

await probe(NAME, async () => {
  // 1. The draft editor renders the assistant.
  const file = join(root, 'packages/web/src/flows/DraftAssistant.tsx');
  if (!existsSync(file)) missing('packages/web/src/flows/DraftAssistant.tsx does not exist (row FW-C-076)');
  const editor = readFileSync(join(root, 'packages/web/src/flows/DraftEditor.tsx'), 'utf8');
  if (!/<DraftAssistant\b/.test(editor)) missing('DraftEditor does not render <DraftAssistant> (row FW-C-076)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('draft-assistant'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/draft-assistant.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the draft assistant checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 draft assistant checks to pass:\n${out.slice(-400)}`);
});
