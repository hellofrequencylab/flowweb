// Probe c0/fake-adapter (FW-C-007; backlog verify_probe adapters/fake-vendor).
// Surface: createAdapter('fake') from packages/adapters/src/index.ts; scenario chosen by a
// "[fake:<name>]" tag in work_order.title (FW-C-007: "selectable by a tag in the work order title").
// Scenarios: the union of FW-C-007 and KICKOFF Prompt 4, nine in all:
//   success, schema_invalid, nonzero_exit, runaway, cost_overrun, fabricated_claim, injection,
//   secret, forbidden_path
// Acceptance:
//   - each scenario produces the expected normalized outcome (run-result.json status) and never crashes
//   - it runs with no network and no keys (proxies point at a dead port, key variables removed)
//   - the fabricated-claim scenario claims a pull_request artifact that does not exist (the input
//     the artifact guard of WS-P0-039 must refuse)
//   - a secret-shaped string emitted by the fake never appears in any emitted event or the result
//   - killing a runaway run leaves no child process (no process has its cwd in the workspace)
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { adapterInput, drain, fakeSecret, requireExport, RUN_RESULT_STATUSES, sleep, tmpDir } from './_lib.mjs';

type Adapter = { start: (i: unknown) => AsyncIterable<Record<string, unknown>>; kill: () => void };
let createAdapter: (name: string, o?: unknown) => Adapter;

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
  const workspace = tmpDir(`fake-${scenario}`);
  const input = adapterInput({ scenario, workspace, ...opts });
  const out = await drain(createAdapter('fake'), input, { timeoutMs: 30000 });
  expect(out.result, `${scenario}: the stream ends with a { type: 'result' } event`).toBeTruthy();
  expect(RUN_RESULT_STATUSES, `${scenario}: status is a run-result.json status`).toContain(out.result.status);
  return { ...out, workspace };
}

describe('c0/fake-adapter', () => {
  beforeAll(async () => {
    createAdapter = (await requireExport('adapters', 'createAdapter', 'FW-C-007')) as typeof createAdapter;
    for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET/i.test(k) && !k.startsWith('GIT_CONFIG_')) delete process.env[k];
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  });

  test('success writes the allowed file and completes', async () => {
    const r = await run('success');
    expect(r.result.status).toBe('completed');
    expect(r.result.exit_code).toBe(0);
    expect(existsSync(join(r.workspace, 'src/feature.txt')), 'the first scope.touches file is written').toBe(true);
  });

  test('schema_invalid and nonzero_exit are failures, reported as typed events', async () => {
    const s = await run('schema_invalid');
    expect(s.result.status).toBe('failed');
    expect(s.events.some((e) => e.type === 'error'), 'a typed error event for the malformed output').toBe(true);
    const n = await run('nonzero_exit');
    expect(n.result.status).toBe('failed');
    expect(n.result.exit_code).not.toBe(0);
  });

  test('runaway is stopped at the wall-clock cap and leaves no process', async () => {
    const r = await run('runaway', { maxWallClockS: 2 });
    expect(r.result.status).toBe('timeout');
    expect(r.ms, 'stopped near the 2 s cap').toBeLessThan(6000);
    await sleep(300);
    expect(pidsInDir(r.workspace), 'no process left running in the workspace').toEqual([]);
  });

  test('cost_overrun is budget_exceeded', async () => {
    const r = await run('cost_overrun', { maxUsd: 0.01 });
    expect(r.result.status).toBe('budget_exceeded');
  });

  test('fabricated_claim claims a pull request that does not exist', async () => {
    const r = await run('fabricated_claim');
    const claimed = (r.result.artifacts ?? []).filter((a: { kind?: string }) => a.kind === 'pull_request');
    expect(claimed.length, 'the result claims a pull_request artifact').toBeGreaterThan(0);
    expect(existsSync(join(r.workspace, '.git')), 'no repository, so no commit backs the claim').toBe(false);
  });

  test('injection text is carried only as untrusted data', async () => {
    const r = await run('injection');
    const carrying = r.events.filter((e) => /ignore (all|previous) instructions/i.test(JSON.stringify(e)));
    expect(carrying.length, 'the injection text is emitted').toBeGreaterThan(0);
    for (const e of carrying) expect(e.untrusted, 'events that carry vendor text are marked untrusted').toBe(true);
  });

  test('secret never appears in events or the result', async () => {
    const r = await run('secret');
    const all = JSON.stringify(r.events) + JSON.stringify(r.result);
    for (const kind of ['anthropic', 'github', 'aws']) {
      expect(all.includes(fakeSecret(kind)), `${kind}-shaped secret leaked`).toBe(false);
    }
    expect(/sk-ant-|ghp_[A-Za-z0-9]|AKIA[0-9A-Z]{4}/.test(all), 'no secret-shaped token at all').toBe(false);
  });

  test('forbidden_path really touches a Tier 0 path (for the diff policy to catch)', async () => {
    const r = await run('forbidden_path');
    expect(existsSync(join(r.workspace, 'CODEOWNERS')), 'the fake wrote CODEOWNERS in the workspace').toBe(true);
    expect(
      existsSync(join(r.workspace, 'probes')) && readdirSync(join(r.workspace, 'probes')).length > 0,
      'the fake wrote a file under probes/ in the workspace',
    ).toBe(true);
  });
});
