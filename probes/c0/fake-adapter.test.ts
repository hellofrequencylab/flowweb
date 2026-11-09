// Probe c0/fake-adapter (FW-C-007; backlog verify_probe adapters/fake-vendor).
// Surface: createAdapter('fake') and FAKE_SCENARIOS from packages/adapters/src/index.ts; the
// scenario is chosen by a "[fake:<name>]" tag in work_order.title (adapterInput sets it). The run is
// read through AdapterRun: run.events (normalized events) and run.result / run.meta.
// Scenarios are the code's nine (FAKE_SCENARIOS): success, fail, hang, secret_leak,
// prompt_injection, over_budget, forbidden_path, malformed_output, fabricated_claim. The draft's
// names (schema_invalid, nonzero_exit, runaway, cost_overrun, injection, secret) map to
// malformed_output, fail, hang, over_budget, prompt_injection, secret_leak.
// Acceptance (FW-C-007, with the KICKOFF Prompt 4 detail):
//   - each scripted behaviour is selectable by a tag in the work order title and produces its
//     expected normalized outcome (run-result.json status) without crashing
//   - it runs with no network and no keys (proxies point at a dead port, key variables removed)
//   - the fabricated-claim scenario claims a pull_request artifact backed by nothing (the input the
//     artifact guard of WS-P0-039 refuses; the run-level refusal is probe c0/artifact-required)
//   - a secret-shaped string emitted by the fake never appears in any emitted event or the result
//   - injection text is kept as data and flagged (run-result injection_suspected)
//   - killing a hung run leaves no child process (no process has its cwd in the workspace)
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { adapterInput, drain, git, gitWorkspace, requireExport, RUN_RESULT_STATUSES, sleep } from './_lib.mjs';

type Ev = Record<string, unknown>;
type Out = { events: Ev[]; result: Record<string, any>; meta: Record<string, any>; ms: number };
let createAdapter: (name: string) => unknown;

function pidsInDir(dir: string) {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (readlinkSync(`/proc/${d}/cwd`).startsWith(dir)) out.push(Number(d));
    } catch {}
  }
  return out;
}

async function run(scenario: string, opts: Record<string, unknown> = {}) {
  const ws = gitWorkspace(`fake-${scenario}`);
  const input = adapterInput({ scenario, workspace: ws.path, ...opts });
  const out = (await drain(createAdapter('fake'), input, { timeoutMs: 30000 })) as Out;
  expect(out.result, `${scenario}: run.result resolves`).toBeTruthy();
  expect(RUN_RESULT_STATUSES, `${scenario}: status is a run-result.json status`).toContain(out.result.status);
  expect(out.result.adapter?.name, `${scenario}: the result names the fake adapter`).toBe('fake');
  return { ...out, workspace: ws.path, base: ws.base_commit, runId: input.run_id as string };
}

describe('c0/fake-adapter', () => {
  beforeAll(async () => {
    createAdapter = (await requireExport('adapters', 'createAdapter', 'FW-C-007')) as typeof createAdapter;
    for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET/i.test(k) && !k.startsWith('GIT_CONFIG_')) delete process.env[k];
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  });

  test('every scripted behaviour exists', async () => {
    const scenarios = (await requireExport('adapters', 'FAKE_SCENARIOS', 'FW-C-007')) as string[];
    for (const s of ['success', 'fail', 'hang', 'secret_leak', 'prompt_injection', 'over_budget', 'forbidden_path', 'malformed_output', 'fabricated_claim']) {
      expect(scenarios, `scenario ${s}`).toContain(s);
    }
  });

  test('success commits the fw-fake note in the workspace and completes', async () => {
    const r = await run('success');
    expect(r.result.status).toBe('completed');
    expect(r.result.exit_code).toBe(0);
    expect(existsSync(join(r.workspace, 'fw-fake', `${r.runId}.md`)), 'fw-fake/<run>.md is written (decision 21)').toBe(true);
    expect(git(r.workspace, 'rev-parse', 'HEAD'), 'the change is committed').not.toBe(r.base);
    expect(r.meta.artifact_sources, 'the commit artifact comes from git, not from the vendor claim').toContain('git');
  });

  test('malformed_output and fail are failures, reported as typed events', async () => {
    const s = await run('malformed_output');
    expect(s.result.status).toBe('failed');
    expect(s.events.some((e) => e.type === 'error'), 'a typed error event for the malformed output').toBe(true);
    const n = await run('fail');
    expect(n.result.status).toBe('failed');
    expect(n.result.exit_code).not.toBe(0);
  });

  test('hang is stopped at the wall-clock cap and leaves no process', async () => {
    const r = await run('hang', { maxWallClockS: 2 });
    expect(r.result.status).toBe('timeout');
    expect(r.ms, 'stopped near the 2 s cap').toBeLessThan(6000);
    await sleep(300);
    expect(pidsInDir(r.workspace), 'no process left running in the workspace').toEqual([]);
  });

  test('over_budget is budget_exceeded', async () => {
    const r = await run('over_budget', { maxUsd: 0.01 });
    expect(r.result.status).toBe('budget_exceeded');
  });

  test('fabricated_claim claims a pull request that nothing backs', async () => {
    const r = await run('fabricated_claim');
    const claimed = (r.result.artifacts ?? []).filter((a: { kind?: string }) => a.kind === 'pull_request');
    expect(claimed.length, 'the result claims a pull_request artifact').toBeGreaterThan(0);
    expect(r.meta.artifact_sources, 'the artifact is marked as a vendor claim').toEqual(['claimed']);
    expect(git(r.workspace, 'rev-parse', 'HEAD'), 'no commit backs the claim').toBe(r.base);
  });

  test('prompt_injection text is kept as data and flagged', async () => {
    const r = await run('prompt_injection');
    const flagged = r.result.injection_suspected ?? [];
    expect(flagged.length, 'run-result injection_suspected lists the injected text').toBeGreaterThan(0);
    expect(JSON.stringify(flagged)).toMatch(/ignore (all )?previous instructions/i);
    expect(r.result.files_changed, 'the run stayed within scope').toEqual([`fw-fake/${r.runId}.md`]);
  });

  test('secret_leak: no secret appears in events or the result', async () => {
    const r = await run('secret_leak');
    const all = JSON.stringify(r.events) + JSON.stringify(r.result);
    expect(/sk-ant-|sk-proj-|ghp_[A-Za-z0-9]{20}|github_pat_|AKIA[0-9A-Z]{12}|xox[bp]-/.test(all), 'no secret-shaped token at all').toBe(false);
  });

  test('forbidden_path really touches Tier 0 paths (for the diff policy to catch)', async () => {
    const r = await run('forbidden_path');
    const files: string[] = r.result.files_changed ?? [];
    expect(files, 'files_changed (from git) lists CODEOWNERS').toContain('CODEOWNERS');
    expect(files.some((f) => f.startsWith('probes/')), 'files_changed lists a file under probes/').toBe(true);
  });
});
