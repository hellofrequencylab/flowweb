// Probe for FW-C-163 (send a draft in one tap: start it in your own mail, then mark it sent and move to the
// next): `pnpm probe flows/one-tap-send`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/DraftsInbox.tsx and DraftEditor.tsx (the drafts inbox, FW-C-066). The
// component checks are in probes/flows/one-tap-send.spec.tsx, run with vitest in jsdom against a fetch stub
// standing in for fwd, as probes/flows/drafts-inbox.mjs does.
//
// The surface this probe expects, for a ready draft with no sender on the Mac (FW-C-071):
//   Copy and send on a draft whose `to` is an email address opens one link (window.open) that starts a new
//     message in the Owner's own mail, carrying the address, the subject and the whole note, URL-encoded;
//     it still copies the note, and it sends no request: FlowWeb sends nothing and marks nothing by itself;
//   the viewer then offers "Yes, I sent it" and "Not yet". Yes posts .../drafts/<id>/mark { outcome: "sent" }
//     and the viewer moves to the next ready draft; Not yet withdraws the question and posts nothing;
//   a draft whose `to` is not an email address (a contact page, a DM) opens no link.
//
// Proves: the component checks pass (3 of them).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/one-tap-send';

await probe(NAME, async () => {
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('one-tap-send'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/one-tap-send.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the one-tap send checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+3 passed/.test(out), `expected 3 one-tap send checks to pass:\n${out.slice(-400)}`);
});
