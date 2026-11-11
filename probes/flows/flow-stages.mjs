// Probe for FW-C-137 (a flow's progress steps come from its own definition, not a list hard-coded in the
// web UI): `pnpm probe flows/flow-stages`.
// probe-timeout-s: 120
// Tier 0.
// Surfaces: flows/<key>/config.json for every shipped flow, a real fwd on a fresh FW_HOME (CLI token),
// GET /v1/supervisor, and the web sources packages/web/src/flows/FlowsHome.tsx, FlowHero.tsx and
// packages/web/src/api/types.ts.
//
// The surface this probe expects:
//   Every shipped flow's config.json has stages: 3 to 7 entries of { key, label }. key is lowercase letters,
//     digits and dashes and unique within the flow; label is 1 to 24 characters with no em dash. The paid
//     ads flow, which drafts nothing to people, has its own stages (not the same labels as
//     neighborhood-activation).
//   Every FlowView in GET /v1/supervisor has stages equal to its config's stages.
//   The web reads them: no array literal of stage words is assigned to FLOW_STAGES (or any *_STAGES) in
//     packages/web/src/flows/FlowsHome.tsx or FlowHero.tsx, FlowHero reads the flow's stages, and the
//     SupervisorFlow type in packages/web/src/api/types.ts has a stages field.
//
// Proves, in order:
//   1. Each flow declares its own stage words.
//   2. fwd serves them on every FlowView.
//   3. The web no longer hard-codes one list for every flow.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/flow-stages';
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const code = (p) =>
  readFileSync(join(root, p), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

await probe(NAME, async () => {
  // ---- 1. each flow declares its stages ---------------------------------------------------------------------
  const keys = readdirSync(join(root, 'flows'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((k) => {
      try {
        readFileSync(join(root, 'flows', k, 'stream.json'));
        return true;
      } catch {
        return false;
      }
    });
  check(keys.length >= 5, `found ${keys.length} shipped flows`);
  const declared = {};
  for (const k of keys) {
    const cfg = JSON.parse(readFileSync(join(root, 'flows', k, 'config.json'), 'utf8'));
    if (!Array.isArray(cfg.stages)) missing(`flows/${k}/config.json has no stages (row FW-C-137)`);
    const st = cfg.stages;
    check(st.length >= 3 && st.length <= 7, `${k} has ${st.length} stages, want 3 to 7`);
    check(st.every((s) => typeof s?.key === 'string' && KEY_RE.test(s.key)), `${k} has a stage key that is not lowercase-with-dashes`);
    check(new Set(st.map((s) => s.key)).size === st.length, `${k} repeats a stage key`);
    check(st.every((s) => typeof s.label === 'string' && s.label.length >= 1 && s.label.length <= 24 && !s.label.includes('—')), `${k} has a stage label that is empty, over 24 characters or has an em dash`);
    declared[k] = st;
  }
  const labels = (k) => JSON.stringify(declared[k]?.map((s) => s.label));
  check(declared['paid-ads'] && labels('paid-ads') !== labels('neighborhood-activation'), 'paid-ads has the same stage words as neighborhood-activation');

  // ---- 2. fwd serves them ------------------------------------------------------------------------------
  const home = realpathSync(freshHome('flow-stages'));
  const f = await startFwd(home);
  try {
    const flows = (await api(f.port, 'GET', '/v1/supervisor', { auth: f.token })).json?.data?.flows ?? [];
    check(flows.length === keys.length, `GET /v1/supervisor lists ${flows.length} flows, the repo ships ${keys.length}`);
    for (const v of flows) {
      if (!('stages' in v)) missing('FlowView has no stages (row FW-C-137)');
      check(JSON.stringify(v.stages) === JSON.stringify(declared[v.key]), `${v.key} serves stages ${JSON.stringify(v.stages)}, its config says ${JSON.stringify(declared[v.key])}`);
    }
  } finally {
    await f.stop();
  }

  // ---- 3. the web reads them ----------------------------------------------------------------------------
  for (const p of ['packages/web/src/flows/FlowsHome.tsx', 'packages/web/src/flows/FlowHero.tsx']) {
    const src = code(p);
    check(!/\b[A-Z_]*STAGES\s*=\s*\[\s*['"]/.test(src), `${p} still assigns a hard-coded list of stage words`);
  }
  check(/\.stages\b/.test(code('packages/web/src/flows/FlowHero.tsx')), 'FlowHero.tsx does not read the flow\'s stages');
  const types = code('packages/web/src/api/types.ts');
  const sf = types.search(/(interface|type)\s+SupervisorFlow\b/);
  check(sf >= 0, 'packages/web/src/api/types.ts has no SupervisorFlow type');
  const body = types.slice(sf, sf + types.slice(sf).search(/\n\}/));
  check(/\bstages\??\s*:/.test(body), 'SupervisorFlow has no stages field');
});
