// Probe for FW-C-087 (each project's brief and labels from Settings, not only `fw project brief` on the Mac):
// `pnpm probe settings/project-settings`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME with a paired browser session, hosted/server/requests.mjs (pure),
// hosted/supabase/migrations/0007_flowweb_flow_ai.sql, and the Settings section
// packages/web/src/settings/ProjectSettings.tsx (its checks are in probes/settings/project-settings.spec.tsx,
// vitest in jsdom against a fetch stub).
//
// The surface this probe expects:
//   POST /v1/projects/{id}/brief { what, who, voice, never, done } and POST /v1/projects/{id}/labels
//     { brand, category } answer the CLI token and now also the paired browser session; making a project
//     (POST /v1/projects) still answers 403 to a browser. A brief missing an answer answers 400.
//   GET /v1/projects shows each project's brief as an object (or null).
//   requestOf: POST /projects/{id}/brief -> project.brief, .../labels -> project.labels, project id in
//     draft_id and flow 'all'; fwdCallFor maps each back; migration 0007 allows both kinds and every kind
//     0005 allowed.
//
// Proves, in order:
//   1. A real fwd takes a brief and labels from a browser session and shows them; refuses an incomplete
//      brief and a browser making a project.
//   2. The site queues both kinds with checked payloads, the relay calls the same routes, migration 0007 allows them.
//   3. The Settings checks pass (3 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'settings/project-settings';
const MIGRATION = 'hosted/supabase/migrations/0007_flowweb_flow_ai.sql';
const EARLIER = 'hosted/supabase/migrations/0005_flowweb_morning_intensity.sql';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const BRIEF = {
  what: 'Local circles for people who love the same things.',
  who: 'Neighbors in North County.',
  voice: 'Warm and plain.',
  never: 'Never send anything without the Owner.',
  done: 'Ten new circles a month.',
};

await probe(NAME, async () => {
  if (!existsSync(join(root, 'packages/web/src/settings/ProjectSettings.tsx')))
    missing('packages/web/src/settings/ProjectSettings.tsx does not exist (row FW-C-087)');

  // 1. A real fwd and its paired browser session.
  const fwd = await startFwd(freshHome('project-settings'), { env: { FW_VENDOR: 'fake' } });
  try {
    const list = async () => (await api(fwd.port, 'GET', '/v1/projects', { auth: fwd.token })).json?.data ?? [];
    let projects = await list();
    if (projects.length === 0) {
      const made = await api(fwd.port, 'POST', '/v1/projects', { auth: fwd.token, body: { slug: 'probe-project', name: 'Probe project' } });
      check(made.status === 200, `making a project with the CLI token answered ${made.status}: ${made.text.slice(0, 200)}`);
      projects = await list();
    }
    const id = projects[0]?.id;
    check(typeof id === 'string', 'fwd lists no project');
    const P = `/v1/projects/${encodeURIComponent(id)}`;
    const { cookie } = await pair(fwd.port, fwd.pairingCode);
    const b = await api(fwd.port, 'POST', `${P}/brief`, { auth: { cookie }, body: BRIEF });
    check(b.status === 200, `a brief from the browser answered ${b.status}: ${b.text.slice(0, 200)}`);
    const shown = (await list()).find((x) => x.id === id);
    check(shown?.brief && typeof shown.brief === 'object' && shown.brief.voice === BRIEF.voice, `GET /v1/projects shows brief ${JSON.stringify(shown?.brief)}`);
    const half = await api(fwd.port, 'POST', `${P}/brief`, { auth: { cookie }, body: { ...BRIEF, done: ' ' } });
    check(half.status === 400, `a brief missing an answer answered ${half.status}, want 400`);
    const l = await api(fwd.port, 'POST', `${P}/labels`, { auth: { cookie }, body: { brand: 'Frequency', category: 'marketing' } });
    check(l.status === 200, `labels from the browser answered ${l.status}: ${l.text.slice(0, 200)}`);
    const labelled = (await list()).find((x) => x.id === id);
    check(labelled?.brand === 'Frequency' && labelled?.category === 'marketing', `labels show ${labelled?.brand} / ${labelled?.category}`);
    const add = await api(fwd.port, 'POST', '/v1/projects', { auth: { cookie }, body: { slug: 'from-browser', name: 'x' } });
    check(add.status === 403, `a browser making a project answered ${add.status}, want 403`);
    const none = await api(fwd.port, 'POST', `${P}/brief`, { body: BRIEF });
    check(none.status === 401 || none.status === 403, `a brief with no session answered ${none.status}`);
  } finally {
    await fwd.stop();
  }

  // 2. The site queue and migration 0007.
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const id = 'prj_frequency1';
  const r = requestOf('POST', `/projects/${id}/brief`, { ...BRIEF, what: `  ${BRIEF.what}  `, extra: 'x' });
  check(r && !r.error && r.kind === 'project.brief' && r.draft_id === id && r.flow === 'all', `the brief became ${JSON.stringify(r)}`);
  check(JSON.stringify(r.payload) === JSON.stringify(BRIEF), `project.brief carries ${JSON.stringify(r.payload)}`);
  const c = fwdCallFor({ id: 'r1', ...r });
  check(c?.method === 'POST' && c.path === `/projects/${id}/brief` && JSON.stringify(c.body) === JSON.stringify(BRIEF), `the relay calls ${JSON.stringify(c)}`);
  check(requestOf('POST', `/projects/${id}/brief`, { ...BRIEF, never: '' })?.error, 'a brief missing an answer was queued');
  const lab = requestOf('POST', `/projects/${id}/labels`, { brand: ' Frequency ', category: null });
  check(lab && lab.kind === 'project.labels' && JSON.stringify(lab.payload) === JSON.stringify({ brand: 'Frequency', category: null }), `labels became ${JSON.stringify(lab)}`);
  const lc = fwdCallFor({ id: 'r2', ...lab });
  check(lc?.path === `/projects/${id}/labels` && JSON.stringify(lc.body) === JSON.stringify(lab.payload), `the relay calls ${JSON.stringify(lc)}`);
  check(requestOf('POST', '/projects/bad id!/brief', BRIEF)?.error, 'a bad project id was queued');
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-086)`);
  const sql = readFileSync(mig, 'utf8');
  const earlier = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'((?:draft|flow|supervisor|hunt)\.[a-z]+)'/g)].map((m) => m[1]);
  for (const k of [...new Set([...earlier, 'project.brief', 'project.labels'])]) check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);

  // 3. The Settings section.
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('project-settings'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/settings/project-settings.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const out = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfgFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const failed = text.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(out.status === 0, `the Settings checks failed (exit ${out.status}):\n${failed.join('\n') || text.slice(-800)}`);
  check(/Tests\s+3 passed/.test(text), `expected 3 Settings checks to pass:\n${text.slice(-400)}`);
});
