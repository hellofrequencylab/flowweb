// Probe for FW-C-171 (a draft with no email address opens the contact page it goes through, and the button
// says what it will do): `pnpm probe flows/draft-contact-page`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/daemon/src/overseer/drafts.ts (the draft fwd lists) and
// packages/web/src/flows/DraftEditor.tsx (the draft viewer, FW-C-163). The component checks are in
// probes/flows/draft-contact-page.spec.tsx, run with vitest in jsdom as probes/flows/one-tap-send.mjs does.
//
// The surface this probe expects, for a ready draft with no sender on the Mac (FW-C-071):
//   listDrafts gives a draft its `contact_url` when the draft file has one and it is an http(s) address;
//   Copy and send on a draft with no email address but a contact page opens that page (window.open) and
//     copies the note; the viewer says before the press that this one has no email address and names the
//     page's site, and it sends no request;
//   a draft with neither says before the press that the button only copies the note, and opens nothing.
//
// Proves: the daemon checks hold and the component checks pass (2 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/draft-contact-page';
const KEY = 'neighborhood-activation';
const DRAFTS_TS = join(root, 'packages/daemon/src/overseer/drafts.ts');

await probe(NAME, async () => {
  // 1. fwd lists the page with each draft.
  const home = tmpDir('draft-contact-page');
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const put = (id, extra) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, lead_id: `lead:${id}`, channel: 'founder_email', subject: 's', body: 'b', status: 'waiting_for_owner', created_at: '2026-11-18T10:00:00Z', ...extra }),
    );
  put('a_form', { contact_url: 'https://riveryoga.example/contact', send_via: 'form' });
  put('b_email', { to: 'hello@frontporch.example' });
  put('c_unsafe', { contact_url: 'javascript:alert(1)' });
  if (!existsSync(DRAFTS_TS)) missing('packages/daemon/src/overseer/drafts.ts does not exist (row FW-C-046)');
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const code = `
    const m = await import(${JSON.stringify(pathToFileURL(DRAFTS_TS).href)});
    const list = m.listDrafts(${JSON.stringify(root)}, ${JSON.stringify(home)}, ${JSON.stringify(KEY)});
    console.log(JSON.stringify(Object.fromEntries(list.map((d) => [d.id, d.contact_url ?? null]))));
  `;
  const t = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 60000 });
  check(t.status === 0, `listing the drafts failed: ${(t.stderr || t.stdout || '').slice(0, 600)}`);
  const got = JSON.parse(t.stdout.trim().split('\n').pop());
  if (got.a_form == null) missing('a listed draft carries no contact_url (row FW-C-171)');
  check(got.a_form === 'https://riveryoga.example/contact', `the contact page is wrong: ${got.a_form}`);
  check(got.b_email === null, `a draft with no contact page got one: ${got.b_email}`);
  check(got.c_unsafe === null, `an address that is not a web page was given: ${got.c_unsafe}`);

  // 2. The inbox shows it.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('draft-contact-page-web'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/draft-contact-page.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the contact page checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+2 passed/.test(out), `expected 2 contact page checks to pass:\n${out.slice(-400)}`);
});
