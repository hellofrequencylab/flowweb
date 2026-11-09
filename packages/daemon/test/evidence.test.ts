// WS-P0-038: the evidence bundle builder is pure, contract-valid, bound to the diff bytes, and its
// view (what the API and the PR comment show) can be derived back from the bundle alone.
import { validate } from '@fw/contracts';
import { describe, expect, test } from 'vitest';
import { evidenceView } from '../src/api/evidence-view.ts';
import {
  buildEvidenceBundle,
  diffFileStats,
  type EvidenceInput,
  evidenceBundleHash,
  POLICY_RULES,
  prComment,
} from '../src/pipeline/evidence.ts';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/docs/n.md b/docs/n.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/n.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');

const AT = '2026-11-09T10:00:00.000Z';
const SHA = 'a'.repeat(40);

function input(patch: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    id: 'evb_01TESTBUNDLE0000000000000A',
    subject: { kind: 'pull_request', ref: 'run_01TESTRUN000000000000000A', sha: SHA },
    code: 'FW-T-001',
    diff: { ref: 'runs/run_01TESTRUN000000000000000A/diff.patch', bytes: DIFF, files: diffFileStats(DIFF) },
    probe: {
      argv: ['sh', 'check.sh'],
      status: 'pass',
      exit_code: 0,
      duration_ms: 12,
      result_id: 'prb_1',
      ran_at: AT,
    },
    checks: [],
    policy: { verdict: { allowed: true, violations: [], checked: 2, diff_hash: 'b'.repeat(64) }, ran_at: AT },
    sandbox: {
      level: 'best_effort',
      mode: 'worktree',
      controls: { filesystem: 'enforced', network: 'absent', env: 'enforced' },
      checked_at: AT,
    },
    adapter: { name: 'fake', vendor: 'local', version: '1.0.0', help_sha256: 'c'.repeat(64), checked_at: AT },
    cost: { usd: 0.0123, tokens_in: 2100, tokens_out: 300, tokens_cached: 0, estimated: false },
    provenance: {
      untrusted_inputs: [],
      rule_of_two: {
        untrusted_input: false,
        sensitive_access: false,
        state_change_or_external_comms: true,
        score: 1,
      },
    },
    now: AT,
    ...patch,
  };
}

describe('evidence bundle builder', () => {
  test('per-file stats from a unified diff', () => {
    expect(diffFileStats(DIFF)).toEqual([
      { path: 'src/a.ts', added: 2, removed: 1 },
      { path: 'docs/n.md', added: 1, removed: 0 },
    ]);
  });

  test('the bundle is valid against evidence-bundle.json and captured by the kernel', () => {
    const b = buildEvidenceBundle(input());
    expect(validate('evidence-bundle', b.bundle).ok).toBe(true);
    expect(b.bundle.captured_by).toBe('kernel');
    expect(b.bundle.intent_payload).toEqual({
      rendered_ref: 'runs/run_01TESTRUN000000000000000A/diff.patch',
      payload_hash: b.diff_hash,
      format: 'diff',
    });
    expect(b.bundle.scan_red).toBe(false);
    // One automated_evidence entry per policy rule, plus probe, check, sandbox, adapter and cost.
    expect(b.bundle.automated_evidence.filter((e) => e.kind === 'diff_policy')).toHaveLength(
      POLICY_RULES.length,
    );
    expect(b.bundle.automated_evidence.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['probe', 'tests', 'other', 'cost_estimate']),
    );
  });

  test('pure: the same input gives the same bundle and hash; the hash covers the diff bytes', () => {
    const a = buildEvidenceBundle(input());
    const b = buildEvidenceBundle(input());
    expect(b.bundle).toEqual(a.bundle);
    expect(a.bundle_hash).toBe(evidenceBundleHash(a.bundle));
    const changed = buildEvidenceBundle(input({ diff: { ...input().diff, bytes: `${DIFF}+x\n` } }));
    expect(changed.diff_hash).not.toBe(a.diff_hash);
    expect(changed.bundle_hash).not.toBe(a.bundle_hash);
  });

  test('a failing probe or a policy violation makes the bundle red and names the failure', () => {
    const red = buildEvidenceBundle(
      input({
        probe: { ...input().probe, status: 'fail', exit_code: 1 },
        policy: {
          verdict: {
            allowed: false,
            violations: [{ path: 'CODEOWNERS', rule: 'tier0_path', status: 'M' }],
            checked: 3,
            diff_hash: 'd'.repeat(64),
          },
          ran_at: AT,
        },
      }),
    );
    expect(red.scan_red).toBe(true);
    expect(red.bundle.scan_red).toBe(true);
    expect(red.failing).toEqual(['row probe', 'diff policy tier0_path']);
    expect(validate('evidence-bundle', red.bundle).ok).toBe(true);
  });

  test('unknown cost is recorded as unknown, never as zero', () => {
    const b = buildEvidenceBundle(
      input({ cost: { usd: null, tokens_in: 0, tokens_out: 0, tokens_cached: 0, estimated: false } }),
    );
    expect(b.bundle.cost_estimate_usd).toBeUndefined();
    expect(b.bundle.not_verified).toContain('The vendor reported no cost; spend is unknown.');
    expect(evidenceView(b.bundle).cost?.usd).toBe('unknown');
  });

  test('the API view is derived back from the bundle', () => {
    const b = buildEvidenceBundle(input());
    const v = evidenceView(b.bundle);
    expect(v.probe).toMatchObject({ status: 'pass', result_id: 'prb_1' });
    expect(v.diff).toEqual({
      hash: b.diff_hash,
      ref: b.bundle.intent_payload.rendered_ref,
      files: ['src/a.ts', 'docs/n.md'],
    });
    expect(v.sandbox).toEqual({
      level: 'best_effort',
      mode: 'worktree',
      controls: { filesystem: 'enforced', network: 'absent', env: 'enforced' },
    });
    expect(v.adapter).toMatchObject({ name: 'fake', vendor: 'local', version: '1.0.0' });
    expect(v.cost).toMatchObject({ usd: '0.0123', estimated: 'false' });
    expect(v.policy.map((p) => p.rule)).toEqual([...POLICY_RULES]);
    expect(v.checks).toEqual([{ name: 'none', status: 'skipped', summary: expect.any(String) }]);
    // A bundle without these entries (a closing bundle) yields nulls, not an error.
    expect(evidenceView({})).toMatchObject({
      probe: null,
      diff: null,
      sandbox: null,
      adapter: null,
      cost: null,
    });
  });

  test('the PR comment names the bundle id and hash, probe, policy, cost and sandbox', () => {
    const i = input();
    const b = buildEvidenceBundle(i);
    const text = prComment({
      bundle: b.bundle,
      diff: { ref: i.diff.ref, files: i.diff.files },
      run_id: i.subject.ref,
      probe: i.probe,
      policy: i.policy.verdict,
      checks: i.checks,
      cost: i.cost,
      sandbox: { level: 'best_effort', mode: 'worktree' },
      adapter: { name: 'fake', version: '1.0.0' },
    });
    for (const s of [
      b.bundle.id,
      b.bundle_hash,
      b.diff_hash,
      'sh check.sh',
      'pass: no violation',
      '$0.0123',
      'best_effort',
    ])
      expect(text).toContain(s);
    expect(text).not.toContain(String.fromCharCode(0x2014)); // no em dashes
  });
});
