// Probe for FW-C-116 (rename, note, archive and restore a flow, on the Mac and from flowweb.app): `pnpm probe flows/flow-manage`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME with a paired browser session (cookie), hosted/server/requests.mjs
// (pure), hosted/supabase/migrations/0011_flowweb_flow_admin.sql, packages/web/src/flows/visible.ts, and
// packages/web's FlowControls (its checks are in probes/flows/flow-manage.spec.tsx, run with vitest in jsdom
// against a fetch stub).
//
// The surface this probe expects:
//   POST /v1/supervisor/flows/{key}/edit { name?, note? } (a string sets it, null or '' clears it) and
//     POST .../archive and .../restore answer the paired session; no session answers 401; an unknown flow 404;
//     a name over 80 characters or an empty body 400. GET /v1/supervisor shows, per flow, name (the Owner's
//     or the shipped one), default_name (the shipped one), note (or null) and archived. Archiving turns the
//     flow off; turning an archived flow on answers 409; restore brings it back, still off.
//   requestOf: POST .../edit -> flow.edit with { name?, note? } trimmed, .../archive -> flow.archive,
//     .../restore -> flow.restore; fwdCallFor maps each back to the same route and body; a bad edit is refused.
//   Migration 0011 allows the three kinds and every kind 0008 allowed.
//   liveFlows drops archived flows.
//   FlowControls: each card has "Edit <name>"; Save posts .../edit; Archive asks first, then posts .../archive;
//     an archived flow has no card and is listed under Archived flows with "Restore <name>", which posts
//     .../restore; a note shows on its card.
//
// Proves, in order:
//   1. fwd renames, notes, archives and restores a flow, and refuses what it should.
//   2. The site queues the three kinds and the relay maps them back.
//   3. Migration 0011 allows them.
//   4. liveFlows hides archived flows.
//   5. The FlowControls checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/flow-manage';
const KEY = 'paid-ads';
const MIGRATION = 'hosted/supabase/migrations/0011_flowweb_flow_admin.sql';
const EARLIER = 'hosted/supabase/migrations/0008_flowweb_sender_settings.sql';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const flowOf = (sup) => (sup?.flows ?? []).find((f) => f.key === KEY);

await probe(NAME, async () => {
  // 1. A real fwd and its paired browser session.
  const S = `/v1/supervisor/flows/${KEY}`;
  const home = freshHome('flow-manage');
  const fwd = await startFwd(home, { env: { FW_VENDOR: 'fake' } });
  try {
    const sup = async () => (await api(fwd.port, 'GET', '/v1/supervisor', { auth: fwd.token })).json?.data;
    const shipped = flowOf(await sup())?.name;
    check(typeof shipped === 'string' && shipped.length > 0, `GET /v1/supervisor lists no ${KEY} flow`);
    const none = await api(fwd.port, 'POST', `${S}/edit`, { body: { name: 'Ads' } });
    check(none.status === 401, `edit without a session or token answered ${none.status}, want 401`);
    const { cookie } = await pair(fwd.port, fwd.pairingCode);
    const post = (path, body = {}) => api(fwd.port, 'POST', path, { auth: { cookie }, body });

    const ed = await post(`${S}/edit`, { name: '  Local ads  ', note: 'Coast first.' });
    if (ed.status === 404 && /not.?found|no route/i.test(ed.text) && !/no flow/.test(ed.text))
      missing(`POST ${S}/edit does not exist (row FW-C-116)`);
    check(ed.status === 200, `edit answered ${ed.status}: ${ed.text.slice(0, 200)}`);
    let f = flowOf(await sup());
    check(f?.name === 'Local ads', `after the rename the flow is named ${JSON.stringify(f?.name)}, want "Local ads"`);
    check(f?.default_name === shipped, `default_name is ${JSON.stringify(f?.default_name)}, want ${JSON.stringify(shipped)}`);
    check(f?.note === 'Coast first.', `the note is ${JSON.stringify(f?.note)}`);
    check(f?.archived === false, `a fresh flow shows archived ${JSON.stringify(f?.archived)}, want false`);
    for (const [body, want, what] of [
      [{ name: 'x'.repeat(81) }, 400, 'a name over 80 characters'],
      [{}, 400, 'an empty edit'],
    ]) {
      const r = await post(`${S}/edit`, body);
      check(r.status === want, `${what} answered ${r.status}, want ${want}`);
    }
    const nf = await post('/v1/supervisor/flows/no-such-flow/edit', { name: 'x' });
    check(nf.status === 404, `editing an unknown flow answered ${nf.status}, want 404`);
    const clear = await post(`${S}/edit`, { name: null, note: '' });
    check(clear.status === 200, `clearing answered ${clear.status}: ${clear.text.slice(0, 200)}`);
    f = flowOf(await sup());
    check(f?.name === shipped && f?.note === null, `clearing left name ${JSON.stringify(f?.name)} and note ${JSON.stringify(f?.note)}`);

    const on = await post(`${S}/enable`);
    check(on.status === 200, `enable answered ${on.status}: ${on.text.slice(0, 200)}`);
    const ar = await post(`${S}/archive`);
    check(ar.status === 200, `archive answered ${ar.status}: ${ar.text.slice(0, 200)}`);
    f = flowOf(await sup());
    check(f?.archived === true && f?.enabled === false, `after archive the flow shows archived ${f?.archived}, enabled ${f?.enabled}`);
    const again = await post(`${S}/enable`);
    check(again.status === 409, `turning on an archived flow answered ${again.status}, want 409`);
    const rs = await post(`${S}/restore`);
    check(rs.status === 200, `restore answered ${rs.status}: ${rs.text.slice(0, 200)}`);
    f = flowOf(await sup());
    check(f?.archived === false && f?.enabled === false, `after restore the flow shows archived ${f?.archived}, enabled ${f?.enabled}`);
  } finally {
    await fwd.stop();
  }

  // 2. The site queues the three kinds; the relay maps them back.
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const P = `/supervisor/flows/${KEY}`;
  const site = [
    [`${P}/edit`, { name: '  Local ads ', note: null, extra: 1 }, 'flow.edit', { name: 'Local ads', note: null }],
    [`${P}/archive`, {}, 'flow.archive', {}],
    [`${P}/restore`, {}, 'flow.restore', {}],
  ];
  for (const [path, body, kind, payload] of site) {
    const r = requestOf('POST', path, body);
    check(r && !r.error, `POST ${path} did not become a request: ${JSON.stringify(r)}`);
    check(r.kind === kind && r.flow === KEY, `POST ${path} became ${r.kind} for ${r.flow}, want ${kind} for ${KEY}`);
    check(JSON.stringify(r.payload) === JSON.stringify(payload), `POST ${path} carries ${JSON.stringify(r.payload)}`);
    const call = fwdCallFor({ id: 'r1', ...r });
    check(call?.method === 'POST' && call.path === path, `${kind}: relay calls ${call?.method} ${call?.path}`);
    check(JSON.stringify(call.body) === JSON.stringify(payload), `${kind}: relay sends ${JSON.stringify(call.body)}`);
  }
  for (const body of [{}, { name: 'x'.repeat(81) }, { note: 'y'.repeat(501) }]) {
    const r = requestOf('POST', `${P}/edit`, body);
    check(r?.error, `POST ${P}/edit ${JSON.stringify(body).slice(0, 60)} should be refused, got ${JSON.stringify(r)}`);
  }

  // 3. Migration 0011.
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-116)`);
  const sql = readFileSync(mig, 'utf8');
  const before = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  for (const k of [...new Set([...before, 'flow.edit', 'flow.archive', 'flow.restore'])])
    check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);

  // 4. liveFlows.
  const { liveFlows } = await imp('packages/web/src/flows/visible.ts');
  const kept = liveFlows([{ key: 'a' }, { key: 'b', archived: true }, { key: 'c', merged_into: 'a' }]).map((x) => x.key);
  check(JSON.stringify(kept) === '["a"]', `liveFlows kept ${JSON.stringify(kept)}, want ["a"]`);

  // 5. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('flow-manage'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/flow-manage.spec.tsx')], testTimeout: 30000 },
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
  check(r.status === 0, `the flow admin checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 flow admin checks to pass:\n${out.slice(-400)}`);
});
