// Probe for FW-C-049 (the Owner saves, runs and deletes lead hunts, and blocks an address, on the local
// FlowWeb flow page): `pnpm probe ui/hunts`. Tier 0.
// Surfaces: packages/web's LeadHunts component, exported from packages/web/src/flows and rendered on
// the flow page (/flows); the hunt routes under /v1/flows/neighborhood-activation/hunts and the
// do-not-contact route, stood in by a fetch stub. The checks are in probes/ui/hunts.spec.tsx; this file
// runs them with vitest in jsdom, resolving react from packages/web.
// The surface this probe expects:
//   <LeadHunts regions={[{ id, name }]} /> renders a section headed "Lead hunts". It loads the saved
//   hunts (GET .../hunts) and lists each by name with a "Run <name> now" button (POST .../hunts/{id}/run,
//   then shows the outcome) and a "Delete <name>" button (asks to confirm, then DELETE .../hunts/{id}).
//   A form with the fields labelled "Name", "Looking for", "Region" (a select of the regions, by id),
//   "Pages to search first" (one address per line; blank lines dropped), "Every how many days", "Most
//   messages per run" and "Build a page they can claim" (a checkbox) and a "Save hunt" button posts
//   { name, looking_for, region, links, every_days, max_sends, build } and reloads the list. fwd's refusal
//   shows in an element with role alert and the form keeps what was typed. A second form, "Address or
//   @domain" and "Reason" with an "Add to do-not-contact" button, posts { email, reason } to
//   .../do-not-contact and says the address was added.
//   ActivationPage renders LeadHunts with the flow's regions.
//
// Proves, in order:
//   1. The flow page renders LeadHunts.
//   2. The component checks in hunts.spec.tsx pass: list, save, refusal, do-not-contact, run and delete.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

await probe('ui/hunts', async () => {
  const page = join(root, 'packages/web/src/flows/ActivationPage.tsx');
  if (!existsSync(page)) missing('packages/web/src/flows/ActivationPage.tsx does not exist');
  check(/<LeadHunts\b/.test(readFileSync(page, 'utf8')), 'the flow page does not render <LeadHunts>');

  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('ui-hunts'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/ui/hunts.spec.tsx')], testTimeout: 30000 },
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
  if (/Failed to resolve import "\.\.\/\.\.\/packages\/web\/src\/flows"|does not provide an export named 'LeadHunts'|LeadHunts is not/.test(out))
    missing('packages/web/src/flows does not export LeadHunts');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the LeadHunts checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+5 passed/.test(out), `expected 5 LeadHunts checks to pass:\n${out.slice(-400)}`);
});
