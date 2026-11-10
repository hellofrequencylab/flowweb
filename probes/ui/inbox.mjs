// Probe for FW-C-068 (one Inbox for the messages to send and the decisions): `pnpm probe ui/inbox`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/table/TablePage.tsx (the /inbox page) and the nav count in
// packages/web/src/shell/Nav.tsx. Its checks are in probes/ui/inbox.spec.tsx, run with vitest in jsdom
// against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   The Inbox page (h1 "Inbox") has a region named "Messages to send ..." holding the flow's DraftsInbox
//   (listbox "All drafts", from GET /v1/supervisor/flows/neighborhood-activation/drafts) and a region named
//   "Decisions ..." holding the open decision cards (GET /v1/decision-cards), saying "No decisions waiting" when there
//   are none. The page says how many are waiting: "<n> messages to send" counts Ready drafts (no blanks,
//   not sent or handled) and "<n> decision(s)" counts open cards. The nav's Inbox count is open cards plus
//   Ready drafts.
//
// Proves, in order:
//   1. The Inbox page renders DraftsInbox.
//   2. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/inbox';

await probe(NAME, async () => {
  // 1. The Inbox page renders the drafts inbox.
  const page = readFileSync(join(root, 'packages/web/src/table/TablePage.tsx'), 'utf8');
  if (!/<DraftsInbox\b/.test(page)) missing('the Inbox page does not render <DraftsInbox> (row FW-C-068)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('inbox'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/inbox.spec.tsx')], testTimeout: 30000 },
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
    missing('the Inbox surface does not exist yet (row FW-C-068)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the Inbox checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 Inbox checks to pass:\n${out.slice(-400)}`);
});
