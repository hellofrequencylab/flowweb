// Probe for FW-C-086 (choose which AI account each flow uses from Settings, not an env var on the Mac):
// `pnpm probe settings/flow-ai`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: packages/daemon/src/overseer/ai.ts (readFlowAi, writeFlowAi), flowEngine in
// packages/daemon/src/overseer/cycle.ts, a real fwd on a fresh FW_HOME with a paired browser session,
// hosted/server/requests.mjs (pure), hosted/supabase/migrations/0007_flowweb_flow_ai.sql, and the Settings
// section packages/web/src/settings/AiSettings.tsx (its checks are in probes/settings/flow-ai.spec.tsx,
// vitest in jsdom against a fetch stub).
//
// The surface this probe expects:
//   writeFlowAi(fwHome, key, { account }) with account claude_plan | anthropic_key | chatgpt_plan | openai_key
//     saves { adapter, auth } in $FW_HOME/flows/<key>/ai.json (mode 600) and throws for anything else;
//     flowEngine(repoRoot, key, fwHome) then answers that account with chosen: true, over config.json.
//   POST /v1/supervisor/flows/{key}/ai { account } answers the CLI token and the paired browser session;
//     GET /v1/supervisor shows per flow ai { adapter, auth, chosen }. A bad account answers 400; an unknown
//     flow 404; no session 401.
//   requestOf: POST .../ai -> flow.ai with payload { account }; fwdCallFor maps it back; migration 0007 allows
//     flow.ai and every kind 0005 allowed.
//
// Proves, in order:
//   1. writeFlowAi and flowEngine as above, and that nothing but the four accounts is saved.
//   2. A real fwd takes the choice from a browser session and shows it.
//   3. The site queues flow.ai, the relay calls the same route with the same body, migration 0007 allows it.
//   4. The Settings checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'settings/flow-ai';
const KEY = 'neighborhood-activation';
const MIGRATION = 'hosted/supabase/migrations/0007_flowweb_flow_ai.sql';
const EARLIER = 'hosted/supabase/migrations/0005_flowweb_morning_intensity.sql';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const flowOf = (sup) => (sup?.flows ?? []).find((f) => f.key === KEY);

await probe(NAME, async () => {
  // 1. The stored choice and the engine it wins over.
  const aiFile = 'packages/daemon/src/overseer/ai.ts';
  if (!existsSync(join(root, aiFile))) missing(`${aiFile} does not exist (row FW-C-086)`);
  const { writeFlowAi, readFlowAi } = await imp(aiFile);
  const { flowEngine } = await imp('packages/daemon/src/overseer/cycle.ts');
  const home = freshHome('flow-ai-pure');
  const before = flowEngine(root, KEY, home);
  check(before.chosen !== true, `with nothing chosen flowEngine says chosen: ${JSON.stringify(before)}`);
  const w = writeFlowAi(home, KEY, { account: 'claude_plan' });
  check(w.changed === true, 'the first choice did not report a change');
  const saved = join(home, 'flows', KEY, 'ai.json');
  check(existsSync(saved), `nothing saved at ${saved}`);
  check((statSync(saved).mode & 0o077) === 0, 'ai.json is readable by others');
  check(JSON.stringify(readFlowAi(home, KEY)) === JSON.stringify({ adapter: 'claude', auth: 'signin' }), `read back ${JSON.stringify(readFlowAi(home, KEY))}`);
  const e = flowEngine(root, KEY, home);
  check(e.adapter === 'claude' && e.auth === 'signin' && e.chosen === true, `flowEngine after the choice: ${JSON.stringify(e)}`);
  check(writeFlowAi(home, KEY, { account: 'claude_plan' }).changed === false, 'the same choice again reported a change');
  for (const body of [{}, { account: 'gemini' }, { account: 'toString' }, { account: '__proto__' }]) {
    let threw = false;
    try {
      writeFlowAi(home, KEY, body);
    } catch {
      threw = true;
    }
    check(threw, `writeFlowAi(${JSON.stringify(body)}) should refuse`);
  }
  const map = { anthropic_key: ['claude', 'api_key'], chatgpt_plan: ['codex', 'signin'], openai_key: ['codex', 'api_key'] };
  for (const [account, [adapter, auth]] of Object.entries(map)) {
    writeFlowAi(home, KEY, { account });
    const x = flowEngine(root, KEY, home);
    check(x.adapter === adapter && x.auth === auth, `${account} gave ${JSON.stringify(x)}`);
  }

  // 2. A real fwd and its paired browser session.
  const S = `/v1/supervisor/flows/${KEY}/ai`;
  const fwdHome = freshHome('flow-ai');
  const fwd = await startFwd(fwdHome, { env: { FW_VENDOR: 'fake' } });
  try {
    const sup = async () => (await api(fwd.port, 'GET', '/v1/supervisor', { auth: fwd.token })).json?.data;
    const none = await api(fwd.port, 'POST', S, { body: { account: 'chatgpt_plan' } });
    check(none.status === 401, `no session answered ${none.status}, want 401`);
    const { cookie } = await pair(fwd.port, fwd.pairingCode);
    const ok = await api(fwd.port, 'POST', S, { auth: { cookie }, body: { account: 'chatgpt_plan' } });
    check(ok.status === 200, `choosing answered ${ok.status}: ${ok.text.slice(0, 200)}`);
    const f = flowOf(await sup());
    check(f?.ai?.adapter === 'codex' && f?.ai?.auth === 'signin' && f?.ai?.chosen === true, `GET /v1/supervisor shows ai ${JSON.stringify(f?.ai)}`);
    const bad = await api(fwd.port, 'POST', S, { auth: { cookie }, body: { account: 'gemini' } });
    check(bad.status === 400, `a bad account answered ${bad.status}, want 400`);
    const nf = await api(fwd.port, 'POST', '/v1/supervisor/flows/no-such-flow/ai', { auth: { cookie }, body: { account: 'claude_plan' } });
    check(nf.status === 404, `an unknown flow answered ${nf.status}, want 404`);
  } finally {
    await fwd.stop();
  }

  // 3. The site queue and migration 0007.
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const P = `/supervisor/flows/${KEY}/ai`;
  const r = requestOf('POST', P, { account: 'openai_key', key: 'not-a-real-key' });
  check(r && !r.error && r.kind === 'flow.ai' && r.flow === KEY, `POST ${P} became ${JSON.stringify(r)}`);
  check(JSON.stringify(r.payload) === JSON.stringify({ account: 'openai_key' }), `flow.ai carries ${JSON.stringify(r.payload)}, want only the account`);
  const call = fwdCallFor({ id: 'r1', ...r });
  check(call?.method === 'POST' && call.path === P && JSON.stringify(call.body) === JSON.stringify({ account: 'openai_key' }), `the relay calls ${JSON.stringify(call)}`);
  check(requestOf('POST', P, { account: 'gemini' })?.error, 'a bad account was queued');
  check(fwdCallFor({ id: 'r2', kind: 'flow.ai', flow: KEY, payload: { account: 'gemini' } }) === null, 'the relay would apply a bad account');
  const mig = join(root, MIGRATION);
  if (!existsSync(mig)) missing(`${MIGRATION} does not exist (row FW-C-086)`);
  const sql = readFileSync(mig, 'utf8');
  const earlier = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'((?:draft|flow|supervisor|hunt)\.[a-z]+)'/g)].map((m) => m[1]);
  for (const k of [...new Set([...earlier, 'flow.ai'])]) check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);

  // 4. The Settings section.
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('flow-ai'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/settings/flow-ai.spec.tsx')], testTimeout: 30000 },
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
  check(/Tests\s+4 passed/.test(text), `expected 4 Settings checks to pass:\n${text.slice(-400)}`);
});
