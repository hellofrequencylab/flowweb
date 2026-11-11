// Probe for FW-C-120 (an owner links their business to Frequency from Settings on flowweb.app, and gets the
// link's secret once to paste into Frequency): `pnpm probe hosted/frequency-link-card`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/hosted/FrequencyLink.tsx (FrequencyLinkPanel), packages/web/src/hosted/auth.ts
// (the /v1/plugin/links calls, served by api/plugin.mjs, row FW-C-111) and
// packages/web/src/settings/SettingsPage.tsx. The checks are in probes/hosted/frequency-link-card.spec.tsx,
// run with vitest in jsdom against a fetch stub, with hosted mode on and a signed-in session saved first.
//
// The surface this probe expects:
//   FrequencyLinkPanel renders an h2 "Link to Frequency". With no link, owners and admins see a
//   "Frequency Space id" box, a "house" checkbox and a "Link to Frequency" button (disabled for an id
//   Frequency would refuse), which sends POST /v1/plugin/links {account, space_id (trimmed), house}.
//   The answer's id and secret are shown once in a status named "New link secret", each with a Copy button,
//   naming FLOWWEB_HOUSE_LINK_ID and FLOWWEB_HOUSE_LINK_SECRET for the house; "I copied them" hides them.
//   A refusal is shown as an alert in the server's words. A linked business shows "Linked to Space <id>" and
//   when Frequency was last heard from; owners and admins get Pause/Resume (PATCH {status}), "Make a new
//   secret" (confirm, then POST .../rotate, shown once) and "Unlink" (confirm, then PATCH {status: revoked}).
//   Helpers and viewers see the link but none of those controls, and no form when unlinked.
//   Settings on the site shows the section.
//
// Proves, in order:
//   1. FrequencyLink.tsx exists and exports FrequencyLinkPanel.
//   2. The component checks pass (7 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'hosted/frequency-link-card';

await probe(NAME, async () => {
  const file = join(root, 'packages/web/src/hosted/FrequencyLink.tsx');
  if (!existsSync(file) || !/export\s+function\s+FrequencyLinkPanel\b/.test(readFileSync(file, 'utf8')))
    missing('packages/web/src/hosted/FrequencyLink.tsx does not export FrequencyLinkPanel (row FW-C-120)');

  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('frequency-link-card'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: {
        environment: 'jsdom',
        environmentOptions: { jsdom: { url: 'https://flowweb.example/' } },
        include: [join(root, 'probes/hosted/frequency-link-card.spec.tsx')],
        testTimeout: 30000,
      },
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
  check(r.status === 0, `the Link to Frequency checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 Link to Frequency checks to pass:\n${out.slice(-400)}`);
});
