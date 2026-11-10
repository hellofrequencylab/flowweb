// Probe for FW-C-088 (an owner sees and manages who shares their business on flowweb.app): `pnpm probe ui/people`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/web/src/hosted/People.tsx (PeoplePanel), packages/web/src/hosted/roles.ts,
// packages/web/src/settings/SettingsPage.tsx, packages/web/src/hosted/auth.ts and packages/web/src/api/client.ts
// (the chosen business goes out as x-fw-account). The checks are in probes/ui/people.spec.tsx, run with vitest
// in jsdom against a fetch stub standing in for the hosted /v1 (row FW-C-083's routes), with hosted mode on
// and a signed-in session saved before the modules load.
//
// The surface this probe expects:
//   PeoplePanel renders an h2 "People". A list named "Members" shows each member's email. Open invites are
//   listed with a "Cancel invite…" button (DELETE /v1/accounts/<id>/invites/<invite id>).
//   Owners and admins see: a "Role for <email>" select on everyone else (PATCH .../members/<user> {role});
//   a "Remove <email>" button that asks window.confirm first (DELETE .../members/<user>); an invite form with
//   an "Invite as" select (admin, helper, viewer), an optional "Email" box (sent trimmed and lower-cased, or
//   null), an "Access" select ("Whole business" or one flow from GET /v1/supervisor; admins always whole
//   business, flows null), and a "Make invite link" button (POST .../invites {role, email, flows}); the
//   returned /join/<token> link is shown with a "Copy link" button.
//   Helpers and viewers see none of those controls, only "Leave <business>" (DELETE .../members/<own id>).
//   A login with no business sees a "Business name" box and a "Make business" button (POST /v1/accounts).
//   With more than one business a "Business" select picks one; every later hosted /v1 call, from People or
//   from api/client.ts, carries x-fw-account: <that id>.
//   roles.ts exports ROLES and can(role, action), matching hosted/server/accounts.mjs.
//   In Settings on the site, the People heading comes after Machines and before Session.
//
// Proves, in order:
//   1. People.tsx exists and exports PeoplePanel.
//   2. The component checks pass (9 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/people';

await probe(NAME, async () => {
  // 1. The panel exists.
  const file = join(root, 'packages/web/src/hosted/People.tsx');
  if (!existsSync(file) || !/export\s+function\s+PeoplePanel\b/.test(readFileSync(file, 'utf8')))
    missing('packages/web/src/hosted/People.tsx does not export PeoplePanel (row FW-C-088)');
  if (!existsSync(join(root, 'hosted/server/accounts.mjs')))
    missing('hosted/server/accounts.mjs is not on this branch yet (row FW-C-083)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('people'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: {
        environment: 'jsdom',
        environmentOptions: { jsdom: { url: 'https://flowweb.example/' } },
        include: [join(root, 'probes/ui/people.spec.tsx')],
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
  check(r.status === 0, `the People checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+9 passed/.test(out), `expected 9 People checks to pass:\n${out.slice(-400)}`);
});
