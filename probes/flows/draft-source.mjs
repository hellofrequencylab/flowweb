// Probe for FW-C-170 (every draft shows a link to the page its contact was found on, so the Owner can look
// before sending): `pnpm probe flows/draft-source`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: packages/daemon/src/overseer/drafts.ts (the draft fwd lists) and
// packages/web/src/flows/DraftsInbox.tsx (the drafts inbox, FW-C-066). The component checks are in
// probes/flows/draft-source.spec.tsx, run with vitest in jsdom as probes/flows/one-tap-send.mjs does.
//
// The surface this probe expects:
//   listDrafts gives each draft `source_url`: the page the hunt recorded (the draft file's source_url); for a
//     draft with none, its contact_url, then its event's url. Drafts already on disk get it the same way,
//     with no rewrite. Only an http(s) address is ever given: anything else leaves the field out.
//   the draft viewer shows "Found on <host>" as a link to that page that opens in a new tab and sends no
//     request; a draft with no page says so and shows no link.
//
// Proves: the daemon checks hold and the component checks pass (2 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/draft-source';
const KEY = 'neighborhood-activation';
const DRAFTS_TS = join(root, 'packages/daemon/src/overseer/drafts.ts');

await probe(NAME, async () => {
  // 1. fwd lists the page with each draft.
  const home = tmpDir('draft-source');
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const put = (id, extra) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, lead_id: `lead:${id}`, channel: 'founder_email', subject: 's', body: 'b', status: 'waiting_for_owner', created_at: '2026-11-18T10:00:00Z', ...extra }),
    );
  put('a_recorded', { source_url: 'https://frontporch.example/contact', contact_url: 'https://other.example/', event: { url: 'https://events.example/1' } });
  put('b_contact', { contact_url: 'https://instagram.example/riveryoga', event: { url: 'https://events.example/2' } });
  put('c_event', { event: { url: 'https://events.example/3' } });
  put('d_none', {});
  put('e_unsafe', { source_url: 'javascript:alert(1)', contact_url: 'mailto:a@b.example' });
  if (!existsSync(DRAFTS_TS)) missing('packages/daemon/src/overseer/drafts.ts does not exist (row FW-C-046)');
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const code = `
    const m = await import(${JSON.stringify(pathToFileURL(DRAFTS_TS).href)});
    const list = m.listDrafts(${JSON.stringify(root)}, ${JSON.stringify(home)}, ${JSON.stringify(KEY)});
    console.log(JSON.stringify(Object.fromEntries(list.map((d) => [d.id, d.source_url ?? null]))));
  `;
  const t = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 60000 });
  check(t.status === 0, `listing the drafts failed: ${(t.stderr || t.stdout || '').slice(0, 600)}`);
  const got = JSON.parse(t.stdout.trim().split('\n').pop());
  if (got.a_recorded == null) missing('a listed draft carries no source_url (row FW-C-170)');
  check(got.a_recorded === 'https://frontporch.example/contact', `the recorded page is not first: ${got.a_recorded}`);
  check(got.b_contact === 'https://instagram.example/riveryoga', `no fallback to the contact page: ${got.b_contact}`);
  check(got.c_event === 'https://events.example/3', `no fallback to the event page: ${got.c_event}`);
  check(got.d_none === null, `a draft with no page got one: ${got.d_none}`);
  check(got.e_unsafe === null, `an address that is not a web page was given: ${got.e_unsafe}`);

  // 2. The inbox shows it.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('draft-source-web'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/draft-source.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the draft source checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+2 passed/.test(out), `expected 2 draft source checks to pass:\n${out.slice(-400)}`);
});
