// Probe c0/evidence-builder (WS-P0-038; backlog verify_probe kernel/evidence-builder).
// Surface: buildEvidenceBundle(input) and prComment(input) exported by packages/daemon/src/index.ts
// (the builder lives in the daemon, not in packages/policy: decision 34), and validate from
// packages/contracts. buildEvidenceBundle({ id, subject, code, diff: { ref, bytes, files }, probe,
// checks, policy, sandbox, adapter, cost, provenance, now }) -> { bundle, bundle_hash, diff_hash,
// scan_red, failing }. evidence-bundle.json has no field for the diff itself (decision 29): the bundle
// carries intent_payload { rendered_ref (the diff file, relative to FW_HOME), payload_hash (sha256 of
// the diff bytes), format: 'diff' }. That the rendered file is the literal diff of a real run is
// checked by c0/run-fake-e2e.
// Acceptance:
//   - the bundle includes the literal diff rendered as text (bound by rendered_ref and payload hash)
//   - changing any member changes the bundle hash (each member mutated in turn); the same input gives
//     the same hash
//   - the bundle is attached to the PR as a comment carrying the hash (the comment text names it;
//     posting it is proven end to end by c0/run-fake-e2e)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { requireExport, root, sha256 } from './_lib.mjs';

type Built = { bundle: Record<string, any>; bundle_hash: string; diff_hash: string; scan_red: boolean };
type Build = (i: Record<string, any>) => Built;

const DIFF =
  'diff --git a/fw-fake/run_probeevb01.md b/fw-fake/run_probeevb01.md\nnew file mode 100644\n--- /dev/null\n+++ b/fw-fake/run_probeevb01.md\n@@ -0,0 +1 @@\n+feature\n';
const AT = '2026-11-09T00:00:00.000Z';
const example = JSON.parse(readFileSync(join(root, 'contracts-core/examples/04-evidence-bundle.json'), 'utf8'));

const base = () => ({
  id: 'evb_01PROBEEVB0000000000000001',
  subject: { kind: 'pull_request', ref: 'fw/FW-C-901/run_probeevb01', sha: 'a'.repeat(40) },
  code: 'FW-C-901',
  diff: { ref: 'runs/run_probeevb01/diff.patch', bytes: DIFF, files: [{ path: 'fw-fake/run_probeevb01.md', added: 1, removed: 0 }] },
  probe: { argv: ['node', 'check-feature.mjs'], status: 'pass', exit_code: 0, duration_ms: 40, result_id: 'prr_probe0001', ran_at: AT },
  checks: [] as unknown[],
  policy: { verdict: { allowed: true, violations: [], checked: 1, diff_hash: 'b'.repeat(64) }, ran_at: AT },
  sandbox: { level: 'best_effort', mode: 'userdir', controls: { env_scrub: 'best_effort', egress: 'absent' }, checked_at: AT },
  adapter: { name: 'fake', vendor: 'local', version: '1.0.0', help_sha256: 'c'.repeat(64), checked_at: AT },
  cost: { usd: 0.12, tokens_in: 1000, tokens_out: 200, tokens_cached: 0, estimated: false },
  provenance: example.provenance,
  now: AT,
});

// One mutation per member of the bundle input.
const MUTATIONS: Record<string, (i: ReturnType<typeof base>) => void> = {
  subject: (i) => {
    i.subject.sha = 'd'.repeat(40);
  },
  diff: (i) => {
    i.diff.bytes = DIFF.replace('+feature', '+featurf');
  },
  diff_ref: (i) => {
    i.diff.ref = 'runs/run_probeevb01/other.patch';
  },
  probe: (i) => {
    i.probe.exit_code = 1;
    i.probe.status = 'fail';
  },
  checks: (i) => {
    i.checks = [{ argv: ['pnpm', 'test'], status: 'pass', exit_code: 0, duration_ms: 5, ran_at: AT }];
  },
  policy: (i) => {
    i.policy.verdict = { allowed: false, violations: [{ path: 'CODEOWNERS', rule: 'tier0_path' }], checked: 1, diff_hash: 'b'.repeat(64) } as never;
  },
  sandbox: (i) => {
    i.sandbox.controls.egress = 'best_effort';
  },
  adapter: (i) => {
    i.adapter.version = '1.0.1';
  },
  cost: (i) => {
    i.cost.usd = 0.13;
  },
  provenance: (i) => {
    i.provenance = { ...i.provenance, untrusted_inputs: [] };
  },
  created_at: (i) => {
    i.now = '2026-11-09T00:00:01.000Z';
  },
};

describe('c0/evidence-builder', () => {
  test('the diff is bound, every member changes the hash, the comment names the hash, schema-valid', async () => {
    const build = (await requireExport('daemon', 'buildEvidenceBundle', 'WS-P0-038')) as Build;
    const prComment = (await requireExport('daemon', 'prComment', 'WS-P0-038')) as (c: Record<string, unknown>) => string;
    const validate = (await requireExport('contracts', 'validate', 'FW-C-002')) as (
      id: string,
      v: unknown,
    ) => { ok: boolean; errors?: unknown };

    const input = base();
    const b = build(input);
    expect(b.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.bundle.bundle_hash).toBe(b.bundle_hash);
    const v = validate('evidence-bundle', b.bundle);
    expect(v.ok, `the bundle validates against evidence-bundle.json: ${JSON.stringify(v.errors)}`).toBe(true);
    expect(b.bundle.captured_by, 'captured by the kernel, never the agent').toBe('kernel');

    // The literal diff, rendered as text at rendered_ref and bound by its hash (decision 29).
    expect(b.bundle.intent_payload).toEqual({ rendered_ref: input.diff.ref, payload_hash: sha256(DIFF), format: 'diff' });
    expect(b.diff_hash).toBe(sha256(DIFF));
    expect(b.bundle.blast_radius.affected).toEqual(['fw-fake/run_probeevb01.md']);

    expect(build(base()).bundle_hash, 'the same input gives the same hash').toBe(b.bundle_hash);
    const seen = new Set([b.bundle_hash]);
    for (const [member, mutate] of Object.entries(MUTATIONS)) {
      const m = base();
      mutate(m);
      const h = build(m).bundle_hash;
      expect(h, `changing ${member} changes the bundle hash`).not.toBe(b.bundle_hash);
      seen.add(h);
    }
    expect(seen.size, 'every mutation gives a distinct hash').toBe(Object.keys(MUTATIONS).length + 1);

    const comment = prComment({
      bundle: b.bundle,
      diff: { ref: input.diff.ref, files: input.diff.files },
      run_id: 'run_probeevb01',
      probe: input.probe,
      policy: input.policy.verdict,
      checks: input.checks,
      cost: input.cost,
      sandbox: input.sandbox,
      adapter: input.adapter,
    });
    expect(comment, 'the PR comment carries the bundle hash').toContain(b.bundle_hash);
    expect(comment, 'the PR comment carries the diff hash').toContain(sha256(DIFF));
  });
});
