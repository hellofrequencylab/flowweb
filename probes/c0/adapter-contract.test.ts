// Probe c0/adapter-contract (WS-P0-027; backlog verify_probe adapters/conformance-suite).
// Surface: the conformance suite in packages/adapters/test/conformance.ts (CASES and
// conformanceSuite(harness), which registers one vitest test per case) and createFakeAdapter from
// packages/adapters/src/index.ts. There is no runConformance() and no built-in broken fake: the
// probe writes a vitest file in a scratch directory that registers the suite for the reference fake
// (case-to-scenario map as in packages/adapters/test/fake.test.ts) and for eight deliberately broken
// fakes, runs it in a child vitest with no keys and a dead proxy, and reads the JSON report.
// Each broken fake wraps the real fake and breaks one guarantee (drops the vendor fingerprint, reports a nonzero
// exit as success, accepts malformed output, hides the budget breach, hides the wall-clock breach,
// drops the session id, leaks the credential, reports a killed run as completed).
// Acceptance (WS-P0-027):
//   - the reference fake adapter passes all 8 cases
//   - a deliberately broken fake fails the matching case each time (and only that case)
//   - the suite runs against fixtures without network or keys
//   - live claude and codex runs are FW_LIVE_VENDORS=1 only (packages/adapters/test/claude.test.ts);
//     they are not part of this probe
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { root, tmpDir } from './_lib.mjs';

const CASES = ['success', 'nonzero_exit', 'missing_result', 'budget_cap', 'wall_clock', 'session_id', 'secret_redaction', 'kill'];

const harness = `
import { createFakeAdapter } from ${JSON.stringify(join(root, 'packages/adapters/src/index.ts'))};
import { CASES, conformanceSuite } from ${JSON.stringify(join(root, 'packages/adapters/test/conformance.ts'))};
import { fakeCredential, makeInput } from ${JSON.stringify(join(root, 'packages/adapters/test/helpers.ts'))};

const scenarioOf = { success: 'success', nonzero_exit: 'fail', missing_result: 'malformed_output', budget_cap: 'over_budget',
  wall_clock: 'hang', session_id: 'success', secret_redaction: 'secret_leak', kill: 'hang' };

function setup(kind, wt) {
  return {
    input: makeInput(wt, (i) => {
      i.work_order.title = '[fake:' + scenarioOf[kind] + '] ' + i.work_order.title;
      if (scenarioOf[kind] === 'hang') i.caps.max_wall_clock_s = kind === 'kill' ? 60 : 1;
    }),
    opts: { killGraceMs: 300, ...(kind === 'secret_redaction' ? { credentialEnv: { FAKE_VENDOR_TOKEN: fakeCredential() } } : {}) },
  };
}

// One sabotage per case. Each is applied to every run of its broken fake.
const breaks = {
  success: { meta: (m) => ({ ...m, fingerprint: null }) },
  nonzero_exit: { result: (r, m) => (m.failure_class === 'nonzero_exit' ? { ...r, status: 'completed' } : r), meta: (m) => (m.failure_class === 'nonzero_exit' ? { ...m, failure_class: null } : m) },
  missing_result: { result: (r, m) => (m.failure_class === 'schema' ? { ...r, status: 'completed' } : r), meta: (m) => (m.failure_class === 'schema' ? { ...m, failure_class: null } : m) },
  budget_cap: { event: (e) => e.type !== 'cap_breach', meta: (m) => (m.cap_breach?.cap === 'wall_clock' ? m : { ...m, cap_breach: null }) },
  wall_clock: { meta: (m) => (m.cap_breach?.cap === 'wall_clock' ? { ...m, cap_breach: null } : m) },
  session_id: { event: (e) => e.type !== 'session' },
  secret_redaction: { leak: true },
  kill: { killed: true },
};

function broken(kind) {
  const real = createFakeAdapter();
  const b = breaks[kind];
  return {
    name: real.name, vendor: real.vendor, capabilities: real.capabilities,
    fingerprint: () => real.fingerprint(), preflight: () => real.preflight(),
    start(input, opts) {
      const run = real.start(input, opts);
      let killed = false;
      const meta = run.meta.then((m) => (b.meta ? b.meta(m) : m));
      const result = Promise.all([run.result, run.meta]).then(([r, m]) => {
        let out = b.result ? b.result(r, m) : r;
        if (b.leak && opts?.credentialEnv) out = { ...out, summary: out.summary + ' ' + Object.values(opts.credentialEnv)[0] };
        if (b.killed && killed) out = { ...out, status: 'completed' };
        return out;
      });
      const events = (async function* () {
        for await (const e of run.events) if (!b.event || b.event(e)) yield e;
      })();
      return { run_id: run.run_id, events, result, meta, pgid: () => run.pgid(),
        kill: (reason) => { killed = true; return run.kill(reason); } };
    },
  };
}

const reference = createFakeAdapter();
conformanceSuite({ label: 'fake', adapter: () => reference, setup });
for (const kind of CASES) conformanceSuite({ label: 'broken:' + kind, adapter: () => broken(kind), setup });
`;

type Assertion = { ancestorTitles: string[]; title: string; status: string };

describe('c0/adapter-contract', () => {
  test('fake passes all 8 cases; each broken fake fails exactly its case; no network or keys', () => {
    const conformance = readFileSync(join(root, 'packages/adapters/test/conformance.ts'), 'utf8');
    for (const c of CASES) expect(conformance.includes(`'${c}'`), `the suite has case ${c}`).toBe(true);

    const dir = tmpDir('conformance');
    writeFileSync(join(dir, 'conformance.test.ts'), harness);
    writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { include: ['*.test.ts'], testTimeout: 30000 } };\n`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (k.startsWith('GIT_CONFIG_') || !/KEY|TOKEN|SECRET|CREDENTIAL/i.test(k))) env[k] = v;
    Object.assign(env, { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' });
    const report = join(dir, 'report.json');
    const r = spawnSync(
      join(root, 'node_modules/.bin/vitest'),
      ['run', '--root', dir, '--config', join(dir, 'vitest.config.mjs'), '--reporter=json', '--outputFile', report],
      { cwd: dir, env, encoding: 'utf8', timeout: 280_000 },
    );
    let json: { testResults: { assertionResults: Assertion[] }[] };
    try {
      json = JSON.parse(readFileSync(report, 'utf8'));
    } catch {
      throw new Error(`the conformance run produced no report: ${(r.stderr || r.stdout).slice(-2000)}`);
    }
    const all = json.testResults.flatMap((t) => t.assertionResults);
    const of = (label: string) => all.filter((a) => a.ancestorTitles.includes(`adapter conformance: ${label}`));

    const ref = of('fake');
    expect(ref.length, 'the suite registers 8 cases for the reference fake').toBe(8);
    const refFailed = ref.filter((a) => a.status !== 'passed').map((a) => a.title);
    expect(refFailed, 'the reference fake fails no case').toEqual([]);

    // conformanceSuite registers its tests in CASES order, so a test's index names its case.
    const titles = ref.map((a) => a.title);
    for (const [i, kind] of CASES.entries()) {
      const failed = of(`broken:${kind}`)
        .filter((a) => a.status !== 'passed')
        .map((a) => a.title);
      expect(failed, `the fake broken for "${kind}" fails exactly "${titles[i]}"`).toEqual([titles[i]]);
    }
  }, 300_000);
});
