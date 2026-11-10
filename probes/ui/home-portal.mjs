// Probe for FW-C-081 (a public homepage on flowweb.app that is also the login portal): `pnpm probe ui/home-portal`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/home/HomePage.tsx and packages/web/src/shell/App.tsx. The checks are in
// probes/ui/home-portal.spec.tsx, run with vitest in jsdom with packages/web/src/hosted/auth.ts stood in by spies
// (signInWithPassword, signUp, sendLink, signInWithGoogle, sendPasswordReset, setPassword, authMethods).
//
// The surface this probe expects:
//   <HomePage notice? recovery? /> renders one h1, names FlowWeb, offers "Sign in" and "Create account" (a tab,
//   button or link), and has no em dash in its text. Sign in: an email input (type email, autocomplete
//   username or email) and a password input (autocomplete current-password) in one form; submitting calls
//   signInWithPassword(email, password). A "Show password" button turns the field to type text. Create account:
//   a password input with autocomplete new-password; submitting calls signUp(email, password) and, on
//   needsConfirm, shows "Check your email". "Email me a link" (or "Email me a sign-in link") calls sendLink(email)
//   and shows "Check your email". "Continue with Google" calls signInWithGoogle(), absent when
//   authMethods.google is false. "Forgot…" leads to a form that calls sendPasswordReset(email) and shows
//   "Check your email". A rejected call's message shows in role="alert"; the notice prop shows as text.
//   With recovery, a heading "Choose a new password" and a new-password input that calls setPassword(password).
//
// Proves, in order:
//   1. App.tsx renders HomePage.
//   2. The component checks pass (9 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/home-portal';

await probe(NAME, async () => {
  // 1. The signed-out site shows the homepage.
  if (!existsSync(join(root, 'packages/web/src/home/HomePage.tsx')))
    missing('packages/web/src/home/HomePage.tsx does not exist (row FW-C-081)');
  const app = readFileSync(join(root, 'packages/web/src/shell/App.tsx'), 'utf8');
  check(/<HomePage\b/.test(app), 'packages/web/src/shell/App.tsx does not render <HomePage> (row FW-C-081)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('home-portal'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/home-portal.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the homepage checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+9 passed/.test(out), `expected 9 homepage checks to pass:\n${out.slice(-400)}`);
});
