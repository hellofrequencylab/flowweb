// Probe c0/evidence-builder (WS-P0-038; backlog verify_probe kernel/evidence-builder).
// Surface: buildEvidenceBundle(input) exported by packages/policy/src/index.ts (files_hint
// packages/policy/src/approvals/src/evidence/), with
//   input = { subject: { kind, ref, sha }, diff, probe: { command, exit_code, stdout_tail },
//             tests: {...}, diffPolicy: {...}, cost: {...} }
//   -> { bundle (evidence-bundle.json), bundle_hash, comment (markdown for the PR) }
// and validate from packages/contracts (FW-C-002) to check the bundle against its schema.
// Acceptance:
//   - the bundle includes the literal diff rendered as text
//   - changing any member changes the bundle hash (each member mutated in turn)
//   - the bundle is attached to the PR as a comment carrying the hash (the comment text names it;
//     posting it is proven end to end by c0/run-fake-e2e)
import { describe, expect, test } from 'vitest';
import { requireExport } from './_lib.mjs';

type Built = { bundle: Record<string, unknown>; bundle_hash: string; comment: string };
type Build = (i: Record<string, unknown>) => Built | Promise<Built>;

const DIFF = 'diff --git a/src/feature.txt b/src/feature.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/feature.txt\n@@ -0,0 +1 @@\n+feature\n';

const base = () => ({
  subject: { kind: 'pull_request', ref: 'https://example.invalid/pr/7', sha: 'a'.repeat(40) },
  diff: DIFF,
  probe: { command: 'node check-feature.mjs', exit_code: 0, stdout_tail: 'ok' },
  tests: { passed: 4, failed: 0 },
  diffPolicy: { ok: true, violations: [] },
  cost: { usd: 0.12, tokens_in: 1000, tokens_out: 200, estimated: false },
  now: '2026-11-09T00:00:00Z', // fixed clock so the same input gives the same hash
});

describe('c0/evidence-builder', () => {
  test('literal diff inside, hash covers every member, comment names the hash, schema-valid', async () => {
    const build = (await requireExport('policy', 'buildEvidenceBundle', 'WS-P0-038')) as Build;
    const validate = (await requireExport('contracts', 'validate', 'WS-P0-038')) as (id: string, v: unknown) => unknown;
    const b = await build(base());
    expect(JSON.stringify(b.bundle), 'the literal diff text is in the bundle').toContain(JSON.stringify(DIFF).slice(1, -1));
    expect(b.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.comment, 'the PR comment carries the bundle hash').toContain(b.bundle_hash);
    const v = validate('https://contracts.invalid/fw/v1/evidence-bundle.json', b.bundle);
    const ok = v === true || (typeof v === 'object' && v !== null && ((v as { ok?: boolean }).ok || (v as { valid?: boolean }).valid));
    expect(ok, `bundle validates against evidence-bundle.json: ${JSON.stringify(v)}`).toBeTruthy();

    const mutations: Record<string, (i: ReturnType<typeof base>) => void> = {
      diff: (i) => {
        i.diff = `${DIFF}+one more line\n`;
      },
      probe: (i) => {
        i.probe.stdout_tail = 'ok!';
      },
      tests: (i) => {
        i.tests.passed = 5;
      },
      diffPolicy: (i) => {
        i.diffPolicy = { ok: false, violations: [] };
      },
      cost: (i) => {
        i.cost.usd = 0.13;
      },
      subject: (i) => {
        i.subject.sha = 'b'.repeat(40);
      },
    };
    for (const [member, mutate] of Object.entries(mutations)) {
      const input = base();
      mutate(input);
      const changed = await build(input);
      expect(changed.bundle_hash, `changing ${member} changes the bundle hash`).not.toBe(b.bundle_hash);
    }
    expect((await build(base())).bundle_hash, 'same input, same hash').toBe(b.bundle_hash);
  });
});
