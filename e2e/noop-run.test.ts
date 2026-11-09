// `fw run start --adapter noop` end to end, as a separate `fw` process against a temp FW_HOME, a temp
// project repo and a local bare "git host". The noop adapter runs no vendor and changes no files, so
// the run must end as one that produced no artifact: failed with failure_class no_artifact, nothing
// pushed, no pull request, no kernel-verified artifact, row back to ready. (run-result.json allows
// `completed` only with an artifact, so the noop reports failed/no_artifact itself and the pipeline
// ends the run with that class before diff policy and the artifact guard.)
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { openStore } from '../packages/eventlog/src/index.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages/cli/src/bin.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CODE = 'FW-T-101';

const dir = mkdtempSync(join(tmpdir(), 'fw-noop-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const home = join(dir, 'home');
const repo = join(dir, 'repo');
const bare = join(dir, 'origin.git');

function fw(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, FW_HOME: home };
  for (const k of ['INIT_CWD', 'FW_GIT_HOST', 'FW_VENDOR', 'FW_CORE_CLIENT']) delete env[k];
  const r = spawnSync(TSX, [BIN, ...args], { cwd: repo, encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function db<T>(fn: (r: ReturnType<ReturnType<typeof openStore>['reader']>) => T): T {
  const store = openStore({ path: join(home, 'db/fw.sqlite'), readonly: true });
  try {
    return fn(store.reader());
  } finally {
    store.close();
  }
}

test('fw run start --adapter noop ends as a run that produced no artifact', () => {
  // A project whose row probe fails until a note exists, so the premise holds and the row can run.
  mkdirSync(join(home, 'config'), { recursive: true });
  copyFileSync(join(ROOT, 'contracts-core/core-policy.yaml'), join(home, 'config/core-policy.yaml'));
  mkdirSync(join(repo, 'ledger', 'rows'), { recursive: true });
  sh(dir, 'git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'owner@example.invalid']);
  sh(repo, 'git', ['config', 'user.name', 'owner']);
  sh(repo, 'git', ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'check.sh'), 'ls notes/*.md >/dev/null 2>&1\n');
  writeFileSync(join(repo, 'README.md'), '# noop\n');
  writeFileSync(
    join(repo, 'ledger', 'rows', `${CODE}.json`),
    JSON.stringify({
      id: CODE,
      title: `Add a note (${CODE})`,
      priority: 'P1',
      size: 'S',
      lane: 'test',
      depends_on: [],
      verify_probe: 'sh check.sh',
      acceptance: ['A note exists under notes/'],
      files_hint: ['notes/**'],
      agent_suitability: 'agent',
      core_milestone: 'C0',
    }),
  );
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-q', '-m', 'base']);
  sh(repo, 'git', ['remote', 'add', 'origin', bare]);
  sh(repo, 'git', ['push', '-q', 'origin', 'main']);
  const base = sh(repo, 'git', ['rev-parse', 'HEAD']);

  const sync = fw('ledger', 'sync');
  expect(sync.code, sync.err).toBe(0);

  const run = fw('run', 'start', CODE, '--adapter', 'noop', '--json');
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(run.out) as Record<string, unknown>;
  } catch {
    throw new Error(`fw run start printed no JSON (exit ${run.code}):\n${run.out}\n${run.err}`);
  }
  expect(run.code, run.err).toBe(1);
  expect(report).toMatchObject({
    ok: false,
    status: 'failed',
    failure_class: 'no_artifact',
    row_status: 'ready',
    pr: null,
    evidence_bundle_id: null,
  });
  const runId = report.run_id as string;
  expect(runId).toMatch(/^run_/);

  // The run row: the noop adapter, nothing spent, no turns.
  const r = db((d) =>
    d.get<Record<string, unknown>>(
      'SELECT status, failure_class, adapter_name, adapter_vendor, adapter_version, cost_usd, turns, session_id, result FROM runs WHERE id = ?',
      [runId],
    ),
  );
  expect(r).toMatchObject({
    status: 'failed',
    failure_class: 'no_artifact',
    adapter_name: 'noop',
    adapter_vendor: 'local',
    turns: 0,
    session_id: `noop_${runId}`,
  });
  expect(r?.cost_usd ?? 0).toBe(0);
  const result = JSON.parse(String(r?.result)) as Record<string, unknown>;
  expect(result).toMatchObject({ artifacts: [], claims: [], turns: 0, cost: { usd: 0 } });

  // Nothing produced: no artifact, no spend, no commit on the run branch, nothing on the host.
  expect(
    db((d) => d.get<{ n: number }>('SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ?', [runId]))?.n,
  ).toBe(0);
  expect(
    db((d) => d.get<{ n: number }>('SELECT COUNT(*) AS n FROM spend_entries WHERE run_id = ?', [runId]))?.n,
  ).toBe(0);
  const branch = report.branch as string;
  expect(sh(repo, 'git', ['rev-parse', `refs/heads/${branch}`])).toBe(base);
  expect(sh(bare, 'git', ['branch', '--list', branch])).toBe('');
  expect(existsSync(`${bare}.prs`)).toBe(false);

  // One run.failed naming no_artifact, no artifact verified, lease released, audit chain intact.
  const events = db((d) =>
    d.all<{ type: string; payload: string }>(
      'SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq',
      [runId],
    ),
  );
  const types = events.map((e) => e.type);
  expect(types.filter((t) => t === 'run.failed')).toHaveLength(1);
  expect(types).toContain('lease.released');
  expect(types).not.toContain('run.artifact_verified');
  const failed = JSON.parse(events.find((e) => e.type === 'run.failed')!.payload) as Record<string, unknown>;
  expect(failed.failure_class).toBe('no_artifact');

  // The prompt was recorded as the run's only step.
  const steps = db((d) =>
    d.all<{ kind: string }>('SELECT kind FROM run_steps WHERE run_id = ? ORDER BY seq', [runId]),
  );
  expect(steps.map((s) => s.kind)).toEqual(['prompt']);
  const stepsFile = readFileSync(join(home, 'runs', runId, 'steps.jsonl'), 'utf8');
  expect(stepsFile).toContain('noop adapter');

  const audit = fw('audit', 'verify', '--json');
  expect(audit.code, audit.err).toBe(0);
  expect(JSON.parse(audit.out)).toMatchObject({ ok: true });
}, 120_000);
