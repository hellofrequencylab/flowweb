// Probe for FW-C-172 (Ready only holds drafts with a way to reach the person; the rest sit in a No address
// group): `pnpm probe flows/ready-means-reachable`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/flows/drafts.ts (the state word a draft shows) and
// packages/web/src/flows/DraftsInbox.tsx (the drafts inbox, FW-C-066). The component checks are in
// probes/flows/ready-means-reachable.spec.tsx, run with vitest in jsdom as probes/flows/draft-source.mjs does.
//
// The surface this probe expects:
//   a waiting draft is Ready only when it has an email address in `to`, or an http(s) contact_url or
//     source_url. A waiting draft with none of them shows the state word "No address", is counted under a
//     "No address" filter and not under Ready, and never opens first while a Ready draft exists.
//   fwd's hunts already refuse a lead with no listed email and no public contact page (counted not_public,
//     packages/daemon/test/hunts.test.ts), so the group only ever holds drafts that reached the list another way.
//
// Proves: the component checks pass (3 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/ready-means-reachable';

await probe(NAME, async () => {
  if (!existsSync(join(root, 'packages/web/src/flows/DraftsInbox.tsx'))) missing('the drafts inbox does not exist (row FW-C-066)');
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('ready-means-reachable-web'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/ready-means-reachable.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the ready checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+3 passed/.test(out), `expected 3 ready checks to pass:\n${out.slice(-400)}`);
});
