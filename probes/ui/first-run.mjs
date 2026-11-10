// Probe for FW-C-082 (first run and invite links on flowweb.app): `pnpm probe ui/first-run`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/home/firstRun.tsx, packages/web/src/home/HomePage.tsx and
// packages/web/src/shell/App.tsx. The checks are in probes/ui/first-run.spec.tsx, run with vitest in jsdom with
// packages/web/src/hosted/auth.ts stood in by spies (createAccount, acceptInvite).
//
// The surface this probe expects:
//   firstRun.tsx exports NameBusiness, JoinInvite, inviteFromPath, rememberInvite, pendingInvite, clearInvite.
//   <NameBusiness onDone /> has a heading "Name your business" and an input with autocomplete="organization" in a
//   form; submitting calls createAccount(trimmed name) then onDone(result); a blank name calls nothing; a rejected
//   call's message shows in role="alert". <JoinInvite token onJoined /> calls acceptInvite(token) once, shows
//   "You're in" and calls onJoined(account_id); a rejection shows in role="alert" with a button naming FlowWeb.
//   inviteFromPath('/join/<token>') is the token, null otherwise; rememberInvite/pendingInvite/clearInvite use
//   sessionStorage. <HomePage invite /> shows text saying the visitor was invited. No em dash in NameBusiness.
//
// Proves, in order:
//   1. App.tsx renders NameBusiness and JoinInvite.
//   2. The component checks pass (7 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/first-run';

await probe(NAME, async () => {
  // 1. The signed-in site walks a new person through first run.
  if (!existsSync(join(root, 'packages/web/src/home/firstRun.tsx')))
    missing('packages/web/src/home/firstRun.tsx does not exist (row FW-C-082)');
  const app = readFileSync(join(root, 'packages/web/src/shell/App.tsx'), 'utf8');
  check(/<NameBusiness\b/.test(app), 'packages/web/src/shell/App.tsx does not render <NameBusiness> (row FW-C-082)');
  check(/<JoinInvite\b/.test(app), 'packages/web/src/shell/App.tsx does not render <JoinInvite> (row FW-C-082)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('first-run'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/first-run.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the first-run checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+7 passed/.test(out), `expected 7 first-run checks to pass:\n${out.slice(-400)}`);
});
