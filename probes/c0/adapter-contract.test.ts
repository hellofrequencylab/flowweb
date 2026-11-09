// Probe c0/adapter-contract (WS-P0-027; backlog verify_probe adapters/conformance-suite).
// Surface: runConformance(adapter) and createAdapter(name, options) from packages/adapters/src/index.ts.
//   runConformance(adapter) -> Promise<Array<{ case: string, ok: boolean, detail?: string }>>
//   createAdapter('fake', { broken: '<case>' }) is the deliberately broken fake for one case.
// Acceptance (WS-P0-027 and KICKOFF Prompt 4):
//   - the reference fake adapter passes all 8 cases
//   - a deliberately broken fake fails the matching case each time (and only that case)
//   - the suite runs against fixtures without network or keys
//   - the same suite passes for claude and codex when FW_LIVE_VENDORS=1 (skipped, not failed, otherwise)
import { describe, expect, test } from 'vitest';
import { requireExport } from './_lib.mjs';

type Result = { case: string; ok: boolean; detail?: string };
type RunConformance = (a: unknown) => Promise<Result[]>;
type CreateAdapter = (name: string, o?: Record<string, unknown>) => unknown;

const live = process.env.FW_LIVE_VENDORS === '1';

describe('c0/adapter-contract', () => {
  test('fake passes all 8 cases; each broken fake fails exactly its case', async () => {
    for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET/i.test(k) && !k.startsWith('GIT_CONFIG_')) delete process.env[k];
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    const runConformance = (await requireExport('adapters', 'runConformance', 'WS-P0-027')) as RunConformance;
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-027')) as CreateAdapter;
    const results = await runConformance(createAdapter('fake'));
    expect(results.length, 'the suite has 8 cases').toBe(8);
    const failed = results.filter((r) => !r.ok);
    expect(failed, `fake fails: ${failed.map((f) => `${f.case}: ${f.detail}`).join('; ')}`).toEqual([]);
    for (const c of results.map((r) => r.case)) {
      const broken = await runConformance(createAdapter('fake', { broken: c }));
      const bad = broken.filter((r) => !r.ok).map((r) => r.case);
      expect(bad, `fake broken for "${c}" fails exactly that case`).toEqual([c]);
    }
  }, 300_000);

  test.skipIf(!live)('claude and codex pass the same suite (FW_LIVE_VENDORS=1)', async () => {
    const runConformance = (await requireExport('adapters', 'runConformance', 'WS-P0-027')) as RunConformance;
    const createAdapter = (await requireExport('adapters', 'createAdapter', 'WS-P0-027')) as CreateAdapter;
    for (const name of ['claude', 'codex']) {
      const failed = (await runConformance(createAdapter(name))).filter((r) => !r.ok);
      expect(failed, `${name} conformance failures`).toEqual([]);
    }
  }, 900_000);
});
