// WS-P0-042: the walking skeleton end to end, as separate `fw` processes against a temp FW_HOME, a
// temp project repo and a local bare "git host". Fake vendor only; no network.
//   fw ledger sync -> fw run start (PR with evidence comment, row verifying) -> Owner merges ->
//   fw ledger close (done, post-merge bundle) -> fw audit verify
// plus the failure cases: forbidden path, over budget, hang, secret leak, fabricated claim, and a
// kill -9 of the CLI mid-run followed by a daemon restart (the reconciler settles the orphan).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { afterAll, describe, expect, test } from 'vitest';
import { groupAlive } from '../packages/adapters/src/index.ts';
import { LocalBareHost, startDaemon } from '../packages/daemon/src/index.ts';
import { openStore } from '../packages/eventlog/src/index.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages/cli/src/bin.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const SECRET = 'fwtest-SECRET-9f3a1c77e2b54d0a';

const tmp = mkdtempSync(join(tmpdir(), 'fw-skeleton-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

interface World {
  dir: string;
  home: string;
  repo: string;
  bare: string;
  rows: string;
  host: LocalBareHost;
  fw(...args: string[]): { code: number | null; out: string; err: string };
  json<T = Record<string, unknown>>(...args: string[]): { code: number | null; body: T; err: string };
  db<T>(fn: (r: ReturnType<ReturnType<typeof openStore>['reader']>) => T): T;
}

/** A project repo whose probe passes once any fw-fake/*.md exists, plus a bare origin and one row per code. */
function world(name: string, codes: string[]): World {
  const dir = join(tmp, name);
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const bare = join(dir, 'origin.git');
  // Row files live in the project repo (the work-order compiler reads files_hint from them).
  const rows = join(repo, 'ledger', 'rows');
  mkdirSync(join(home, 'config'), { recursive: true });
  copyFileSync(join(ROOT, 'contracts-core/core-policy.yaml'), join(home, 'config/core-policy.yaml'));
  mkdirSync(rows, { recursive: true });
  sh(dir, 'git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'owner@example.invalid']);
  sh(repo, 'git', ['config', 'user.name', 'owner']);
  sh(repo, 'git', ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'check.sh'), 'ls fw-fake/*.md >/dev/null 2>&1\n');
  writeFileSync(join(repo, 'README.md'), '# skeleton\n');
  for (const code of codes)
    writeFileSync(
      join(rows, `${code}.json`),
      JSON.stringify({
        id: code,
        title: `Add the fake note (${code})`,
        priority: 'P1',
        size: 'S',
        lane: 'test',
        depends_on: [],
        verify_probe: 'sh check.sh',
        acceptance: ['A note exists under fw-fake/'],
        files_hint: ['fw-fake/**', 'src/**'],
        agent_suitability: 'agent',
        core_milestone: 'C0',
      }),
    );
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-q', '-m', 'base']);
  sh(repo, 'git', ['remote', 'add', 'origin', bare]);
  sh(repo, 'git', ['push', '-q', 'origin', 'main']);
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, FW_HOME: home };
    delete e.INIT_CWD;
    delete e.FW_GIT_HOST;
    delete e.FW_VENDOR;
    delete e.FW_CORE_CLIENT;
    return e;
  };
  const fw = (...args: string[]) => {
    const r = spawnSync(TSX, [BIN, ...args], { cwd: repo, encoding: 'utf8', env: env(), timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return {
    dir,
    home,
    repo,
    bare,
    rows,
    host: new LocalBareHost(bare),
    fw,
    json<T>(...args: string[]) {
      const r = fw(...args, '--json');
      let body: T;
      try {
        body = JSON.parse(r.out) as T;
      } catch {
        throw new Error(`fw ${args.join(' ')} printed no JSON (exit ${r.code}):\n${r.out}\n${r.err}`);
      }
      return { code: r.code, body, err: r.err };
    },
    db(fn) {
      const store = openStore({ path: join(home, 'db/fw.sqlite'), readonly: true });
      try {
        return fn(store.reader());
      } finally {
        store.close();
      }
    },
  };
}

interface StartReport {
  ok: boolean;
  run_id: string | null;
  status: string;
  failure_class: string | null;
  reason: string | null;
  policy_code: string | null;
  row_status: string;
  branch: string | null;
  worktree: string | null;
  pr: { number: number; url: string; head_sha: string } | null;
  evidence_bundle_id: string | null;
  bundle_hash: string | null;
  sandbox_level: string | null;
  cost_usd: number | null;
}

/** What the fake vendor's success scenario reports as the run's total cost (packages/adapters/src/fake/vendor.mjs). */
const FAKE_REPORTED_USD = 0.0123;

const eventsOf = (w: World, runId: string) =>
  w.db((r) =>
    r.all<{ type: string; payload: string }>(
      'SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq',
      [runId],
    ),
  );

describe('walking skeleton: success path', () => {
  const w = world('happy', ['FW-T-001']);

  test('sync, run start, merge, close, audit verify', async () => {
    const sync = w.fw('ledger', 'sync');
    expect(sync.code, sync.err).toBe(0);

    const start = w.json<StartReport>('run', 'start', 'FW-T-001', '--adapter', 'fake');
    expect(start.code, JSON.stringify(start.body)).toBe(0);
    const r = start.body;
    expect(r).toMatchObject({ ok: true, status: 'succeeded', row_status: 'verifying', failure_class: null });
    expect(r.pr?.url).toMatch(/^file:\/\/.*\/pull\/1$/);
    expect(r.evidence_bundle_id).toMatch(/^evb_/);
    expect(r.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(['enforced', 'best_effort', 'absent']).toContain(r.sandbox_level);

    // The PR carries the evidence comment.
    const comments = w.host.comments(r.pr!.number);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(r.evidence_bundle_id!);
    expect(comments[0]).toContain(r.bundle_hash!);
    expect(comments[0]).toMatch(/probe/i);
    expect(comments[0]).toMatch(/sandbox/i);

    // Kernel-verified artifacts, run.started carries the sandbox level, the bundle is in the db.
    const arts = w.db((d) =>
      d.all<{ kind: string; verified_by_kernel: number }>(
        'SELECT kind, verified_by_kernel FROM run_artifacts WHERE run_id = ?',
        [r.run_id],
      ),
    );
    expect(arts.map((a) => a.kind).sort()).toEqual(['commit', 'pull_request']);
    expect(arts.every((a) => a.verified_by_kernel === 1)).toBe(true);
    const evs = eventsOf(w, r.run_id!);
    const types = evs.map((e) => e.type);
    for (const t of [
      'lease.acquired',
      'run.queued',
      'run.started',
      'evidence.bundle_created',
      'run.succeeded',
      'lease.released',
    ])
      expect(types).toContain(t);
    const started = JSON.parse(evs.find((e) => e.type === 'run.started')!.payload);
    expect(started.sandbox_level).toBe(r.sandbox_level);

    // run list / show.
    const list = w.json<{ id: string }[]>('run', 'list');
    expect(list.body.map((x) => x.id)).toContain(r.run_id);
    const show = w.fw('run', 'show', r.run_id!);
    expect(show.code).toBe(0);
    expect(show.out).toContain(r.bundle_hash!);

    // The cost record (decision 32): one spend entry per priced model turn, written as it streamed,
    // plus one `<run>:final` entry for what the vendor's total adds beyond them. Together they equal
    // the vendor's reported cost, and runs.cost_usd, fw run start and fw run show all report that sum.
    const spend = w.db((d) =>
      d.all<{ idempotency_key: string; usd: number }>(
        'SELECT idempotency_key, usd FROM spend_entries WHERE run_id = ? ORDER BY ts, id',
        [r.run_id],
      ),
    );
    const turns = w.db((d) =>
      d.all<{ seq: number; cost_usd: number }>(
        "SELECT seq, cost_usd FROM run_steps WHERE run_id = ? AND kind = 'model_turn' ORDER BY seq",
        [r.run_id],
      ),
    );
    expect(turns).toHaveLength(2); // the success scenario streams two priced turns
    const stepSpend = spend.filter((s) => s.idempotency_key.startsWith(`${r.run_id}:step:`));
    const finalSpend = spend.filter((s) => s.idempotency_key === `${r.run_id}:final`);
    expect(stepSpend.map((s) => s.idempotency_key)).toEqual(turns.map((t) => `${r.run_id}:step:${t.seq}`));
    expect(stepSpend.map((s) => s.usd)).toEqual(turns.map((t) => t.cost_usd));
    expect(stepSpend.every((s) => s.usd > 0)).toBe(true);
    expect(finalSpend).toHaveLength(1);
    expect(spend).toHaveLength(stepSpend.length + 1);
    const spendSum = spend.reduce((sum, s) => sum + s.usd, 0);
    expect(spendSum).toBeCloseTo(FAKE_REPORTED_USD, 9);
    const runCost = w.db(
      (d) =>
        d.get<{ cost_usd: number | null }>('SELECT cost_usd FROM runs WHERE id = ?', [r.run_id])!.cost_usd,
    );
    expect(runCost).toBeCloseTo(spendSum, 9);
    expect(r.cost_usd).toBeCloseTo(spendSum, 9);
    const shownCost = w.json<{ cost: { usd: number | null; entries: number; known: boolean } }>(
      'run',
      'show',
      r.run_id!,
    ).body.cost;
    expect(shownCost).toMatchObject({ entries: spend.length, known: true });
    expect(shownCost.usd).toBeCloseTo(spendSum, 9);

    // Owner merges, the checkout follows main, then close.
    const merged = await w.host.merge(r.pr!.number);
    sh(w.repo, 'git', ['pull', '-q', '--ff-only', 'origin', 'main']);
    const close = w.json<{ status: string; bundle_id: string; bundle_hash: string }>(
      'ledger',
      'close',
      'FW-T-001',
      '--merged-sha',
      merged.merged_sha!,
    );
    expect(close.code, JSON.stringify(close.body)).toBe(0);
    expect(close.body.status).toBe('done');
    expect(close.body.bundle_id).not.toBe(r.evidence_bundle_id);

    const audit = w.json<{ ok: boolean }>('audit', 'verify');
    expect(audit.code).toBe(0);
    expect(audit.body.ok).toBe(true);

    // fwd serves the run bundle with a view derived from it, and the stored diff under its hash.
    const d = await startDaemon({ fwHome: w.home, port: 0, devNoAuth: true, log: () => {} });
    try {
      const eb = (await (await fetch(`${d.url}/v1/evidence-bundles/${r.evidence_bundle_id}`)).json()) as {
        data: {
          bundle_hash: string;
          view: {
            probe: { status: string };
            sandbox: { level: string };
            diff: { hash: string; files: string[] };
            policy: { status: string }[];
          };
        };
      };
      expect(eb.data.bundle_hash).toBe(r.bundle_hash);
      expect(eb.data.view.probe.status).toBe('pass');
      expect(eb.data.view.sandbox.level).toBe(r.sandbox_level);
      expect(eb.data.view.diff.files).toEqual([expect.stringMatching(/^fw-fake\/run_.*\.md$/)]);
      expect(eb.data.view.policy.every((p: { status: string }) => p.status === 'pass')).toBe(true);
      const diff = await fetch(`${d.url}/v1/evidence-bundles/${r.evidence_bundle_id}/diff`);
      expect(diff.status).toBe(200);
      expect(diff.headers.get('x-fw-sha256')).toBe(eb.data.view.diff.hash);
    } finally {
      await d.stop('test done');
    }
  }, 120_000);
});

const runRow = (w: World, runId: string) =>
  w.db((d) =>
    d.get<{ status: string; failure_class: string | null; workspace_path: string; branch: string }>(
      'SELECT status, failure_class, workspace_path, branch FROM runs WHERE id = ?',
      [runId],
    ),
  )!;
const leaseStatuses = (w: World, runId: string) =>
  w.db((d) =>
    d.all<{ status: string }>('SELECT status FROM leases WHERE run_id = ?', [runId]).map((l) => l.status),
  );
const rowStatus = (w: World, code: string) =>
  w.db((d) =>
    d.get<{ status: string }>("SELECT status FROM ledger_rows WHERE id = 'lr_' || replace(?, '-', '')", [
      code,
    ]),
  )?.status;
const hasPrs = (w: World) => existsSync(`${w.bare}.prs`);

/** Everything a run left in the database and on disk, as one string (for leak checks). */
function everything(w: World, runId: string): string {
  const db = w.db((d) =>
    JSON.stringify({
      events: d.all('SELECT * FROM events'),
      steps: d.all('SELECT * FROM run_steps WHERE run_id = ?', [runId]),
      runs: d.all('SELECT * FROM runs'),
      evidence: d.all('SELECT * FROM evidence_bundles'),
    }),
  );
  const steps = join(w.home, 'runs', runId, 'steps.jsonl');
  return db + (existsSync(steps) ? readFileSync(steps, 'utf8') : '');
}

describe('walking skeleton: failure cases', () => {
  test('forbidden_path: the run fails, the branch is quarantined, nothing is pushed', () => {
    const w = world('forbidden', ['FW-T-002']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    const r = w.json<StartReport>(
      'run',
      'start',
      'FW-T-002',
      '--adapter',
      'fake',
      '--scenario',
      'forbidden_path',
    );
    expect(r.code).toBe(3); // refused by policy (decision 22)
    expect(r.body).toMatchObject({
      ok: false,
      status: 'failed',
      failure_class: 'policy',
      policy_code: 'DIFF_POLICY',
      pr: null,
    });
    expect(r.body.reason).toMatch(/diff policy violation/);
    expect(r.body.branch).toBe(`fw/quarantine/${r.body.run_id}`);
    expect(sh(w.repo, 'git', ['branch', '--list', 'fw/quarantine/*'])).toContain(r.body.run_id!);
    expect(hasPrs(w)).toBe(false);
    const types = eventsOf(w, r.body.run_id!).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'policy.diff_policy_failed',
        'policy.tamper_tripwire_fired',
        'run.failed',
        'lease.released',
      ]),
    );
    expect(leaseStatuses(w, r.body.run_id!)).toEqual(['released']);
    expect(rowStatus(w, 'FW-T-002')).toBe('ready');
    expect(existsSync(r.body.worktree!)).toBe(true); // kept for inspection

    // fw gc removes the finished run's directory, never its worktree or its quarantined branch.
    const runDir = join(w.home, 'runs', r.body.run_id!);
    expect(existsSync(runDir)).toBe(true);
    const gc = w.json<{ removed: { run_id: string; status: string | null }[]; kept: unknown[] }>('gc');
    expect(gc.code).toBe(0);
    expect(gc.body.removed).toContainEqual(
      expect.objectContaining({ run_id: r.body.run_id, status: 'failed' }),
    );
    expect(gc.body.kept).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(r.body.worktree!)).toBe(true);
    expect(sh(w.repo, 'git', ['branch', '--list', 'fw/quarantine/*'])).toContain(r.body.run_id!);
  }, 60_000);

  test('over_budget: the run is killed with failure_class budget', () => {
    const w = world('budget', ['FW-T-003']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    const r = w.json<StartReport>(
      'run',
      'start',
      'FW-T-003',
      '--adapter',
      'fake',
      '--scenario',
      'over_budget',
    );
    expect(r.code).toBe(1);
    expect(r.body).toMatchObject({ status: 'killed', failure_class: 'budget' });
    expect(hasPrs(w)).toBe(false);
    expect(leaseStatuses(w, r.body.run_id!)).toEqual(['released']);
    expect(rowStatus(w, 'FW-T-003')).toBe('ready');
  }, 60_000);

  test('hang: the wall clock fires and no vendor process is left', () => {
    const w = world('hang', ['FW-T-004']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    const t0 = Date.now();
    const r = w.json<StartReport>(
      'run',
      'start',
      'FW-T-004',
      '--adapter',
      'fake',
      '--scenario',
      'hang',
      '--max-wall-clock-s',
      '2',
    );
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.code).toBe(1);
    expect(r.body).toMatchObject({ status: 'timed_out', failure_class: 'timeout' });
    const started = JSON.parse(eventsOf(w, r.body.run_id!).find((e) => e.type === 'run.started')!.payload);
    expect(typeof started.vendor_pgid).toBe('number');
    expect(groupAlive(started.vendor_pgid)).toBe(false);
    expect(leaseStatuses(w, r.body.run_id!)).toEqual(['released']);
  }, 60_000);

  test('secret_leak: the credential value never reaches events, steps, results or output', () => {
    const w = world('leak', ['FW-T-005']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    mkdirSync(join(w.home, 'creds'), { recursive: true, mode: 0o700 });
    const cred = join(w.home, 'creds', 'crd_fake0001');
    writeFileSync(cred, `${SECRET}\n`, { mode: 0o600 });
    chmodSync(cred, 0o600);
    const out = w.fw('run', 'start', 'FW-T-005', '--adapter', 'fake', '--scenario', 'secret_leak', '--json');
    const body = JSON.parse(out.out) as StartReport;
    expect(body.run_id).toMatch(/^run_/);
    const started = JSON.parse(eventsOf(w, body.run_id!).find((e) => e.type === 'run.started')!.payload);
    expect(JSON.stringify(started)).toContain('crd_fake0001'); // the handle is recorded, the value is not
    expect(everything(w, body.run_id!)).not.toContain(SECRET);
    expect(out.out + out.err).not.toContain(SECRET);
    if (body.pr) expect(w.host.comments(body.pr.number).join('\n')).not.toContain(SECRET);
  }, 60_000);

  test('a group-readable credential file is refused with a typed error and never read into the run', () => {
    const w = world('insecure', ['FW-T-006']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    mkdirSync(join(w.home, 'creds'), { recursive: true });
    const cred = join(w.home, 'creds', 'crd_fake0001');
    writeFileSync(cred, `${SECRET}\n`);
    chmodSync(cred, 0o640);
    const r = w.json<StartReport>('run', 'start', 'FW-T-006', '--adapter', 'fake');
    expect(r.code).toBe(1);
    expect(r.body).toMatchObject({ status: 'failed', failure_class: 'adapter' });
    expect(r.body.reason).toMatch(/crd_fake0001.*chmod 600/);
    const failed = eventsOf(w, r.body.run_id!).find((e) => e.type === 'run.failed')!;
    expect(JSON.parse(failed.payload).credential_error).toBe('CREDENTIAL_INSECURE');
    expect(everything(w, r.body.run_id!)).not.toContain(SECRET);
  }, 60_000);

  test('fabricated_claim: a claimed PR the kernel cannot find fails the run', () => {
    const w = world('fabricated', ['FW-T-007']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    const r = w.json<StartReport>(
      'run',
      'start',
      'FW-T-007',
      '--adapter',
      'fake',
      '--scenario',
      'fabricated_claim',
    );
    expect(r.code).toBe(1);
    expect(['claim_mismatch', 'no_artifact']).toContain(r.body.failure_class);
    expect(r.body.status).toBe('failed');
    expect(hasPrs(w)).toBe(false);
    const arts = w.db((d) =>
      d.all<{ verified_by_kernel: number }>('SELECT verified_by_kernel FROM run_artifacts WHERE run_id = ?', [
        r.body.run_id,
      ]),
    );
    expect(arts.every((a) => a.verified_by_kernel === 0)).toBe(true);
    expect(rowStatus(w, 'FW-T-007')).toBe('ready');
  }, 60_000);

  test('kill -9 mid-run, then fwd restarts: the reconciler fails the run once and nothing runs twice', async () => {
    const w = world('crash', ['FW-T-008']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    mkdirSync(join(w.home, 'creds'), { recursive: true, mode: 0o700 });
    writeFileSync(join(w.home, 'creds', 'crd_fake0001'), SECRET, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, FW_HOME: w.home };
    delete env.INIT_CWD;
    delete env.FW_VENDOR;
    const args = [
      '--import',
      'tsx',
      BIN,
      'run',
      'start',
      'FW-T-008',
      '--adapter',
      'fake',
      '--scenario',
      'hang',
    ];
    const child: ChildProcess = spawn(process.execPath, [...args, '--repo', w.repo], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
    });
    const exited = new Promise<void>((ok) => child.on('exit', () => ok()));
    // Wait until the vendor is spawned (run.started carries its process group).
    let runId: string | undefined;
    let pgid: number | undefined;
    for (let i = 0; i < 400 && pgid === undefined; i++) {
      await new Promise((ok) => setTimeout(ok, 50));
      if (!existsSync(join(w.home, 'db/fw.sqlite'))) continue;
      const ev = w.db((d) =>
        d.get<{ run_id: string; payload: string }>(
          "SELECT run_id, payload FROM events WHERE type = 'run.started'",
        ),
      );
      if (ev) {
        runId = ev.run_id;
        pgid = JSON.parse(ev.payload).vendor_pgid as number;
      }
    }
    expect(runId).toBeDefined();
    // Kill only once the vendor has reached its hang (it reported the grandchild), so it is not still
    // writing its first lines into a pipe that the kill is about to close.
    for (let i = 0; i < 400; i++) {
      const n = w.db((d) =>
        d.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'tool_result'",
          [runId],
        ),
      );
      if ((n?.n ?? 0) > 0) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(runRow(w, runId!).status).toBe('running');
    if (process.platform === 'linux') {
      // The credential reached the vendor through its environment only, never its argv.
      const proc = (f: string) => readFileSync(`/proc/${pgid}/${f}`, 'utf8').split('\0');
      expect(proc('cmdline').join(' ')).not.toContain(SECRET);
      expect(proc('environ')).toContain(`FAKE_VENDOR_API_KEY=${SECRET}`);
    }
    child.kill('SIGKILL');
    await exited;
    expect(groupAlive(pgid!)).toBe(true); // the vendor outlived its supervisor

    const d = await startDaemon({ fwHome: w.home, port: 0, devNoAuth: true, log: () => {} });
    try {
      expect(d.reconcile.runs_failed).toEqual([runId]);
      expect(d.reconcile.groups_killed).toEqual([pgid]);
    } finally {
      await d.stop('test done');
    }
    for (let i = 0; i < 40 && groupAlive(pgid!); i++) await new Promise((ok) => setTimeout(ok, 50));
    expect(groupAlive(pgid!)).toBe(false);
    expect(runRow(w, runId!)).toMatchObject({ status: 'failed', failure_class: 'killed' });
    expect(leaseStatuses(w, runId!)).toEqual(['released']);
    expect(rowStatus(w, 'FW-T-008')).toBe('ready');
    const count = (type: string) =>
      w.db(
        (r) =>
          r.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE type = ? AND run_id = ?', [
            type,
            runId,
          ])!.n,
      );
    expect(count('run.started')).toBe(1);
    expect(count('run.failed')).toBe(1);

    // A second restart has nothing to reconcile: the run is never failed or started twice.
    const again = await startDaemon({ fwHome: w.home, port: 0, devNoAuth: true, log: () => {} });
    expect(again.reconcile.runs_failed).toEqual([]);
    await again.stop('test done');
    expect(count('run.failed')).toBe(1);
    expect(count('run.started')).toBe(1);
  }, 90_000);

  test('with fwd up, fw run start hands the run to fwd; stopping fwd records it as interrupted; fw status reads either way', async () => {
    const w = world('hosted', ['FW-T-009']);
    expect(w.fw('ledger', 'sync').code).toBe(0);
    const d = await startDaemon({ fwHome: w.home, port: 0, log: () => {} });
    const env: NodeJS.ProcessEnv = { ...process.env, FW_HOME: w.home, FW_PORT: String(d.port) };
    delete env.INIT_CWD;
    delete env.FW_VENDOR;
    delete env.FW_CORE_CLIENT;
    const fwAsync = (args: string[]) => {
      const child = spawn(process.execPath, ['--import', 'tsx', BIN, ...args, '--repo', w.repo], {
        cwd: ROOT,
        env,
      });
      let out = '';
      child.stdout!.on('data', (b: Buffer) => {
        out += b.toString('utf8');
      });
      const code = new Promise<number | null>((ok) => child.on('exit', (c) => ok(c)));
      return { code, out: () => out };
    };
    let stopped = false;
    try {
      const up = fwAsync(['status', '--json']);
      expect(await up.code).toBe(0);
      expect(JSON.parse(up.out())).toMatchObject({ daemon: 'up', source: 'daemon', started_at: d.startedAt });

      const cli = fwAsync(['run', 'start', 'FW-T-009', '--adapter', 'fake', '--scenario', 'hang', '--json']);
      let runId: string | undefined;
      let pgid: number | undefined;
      for (let i = 0; i < 600 && pgid === undefined; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
        const ev = w.db((r) =>
          r.get<{ run_id: string; payload: string }>(
            "SELECT run_id, payload FROM events WHERE type = 'run.started'",
          ),
        );
        if (ev) {
          runId = ev.run_id;
          pgid = JSON.parse(ev.payload).vendor_pgid as number;
        }
      }
      expect(runId).toBeDefined();
      expect(d.runs.size).toBe(1); // fwd owns the run, not the CLI process
      expect(groupAlive(pgid!)).toBe(true);

      await d.stop('signal SIGTERM');
      stopped = true;
      expect(groupAlive(pgid!)).toBe(false);
      // The CLI still gets the run's ending from fwd.
      expect(await cli.code).toBe(1);
      expect(JSON.parse(cli.out())).toMatchObject({
        run_id: runId,
        status: 'killed',
        failure_class: 'killed',
      });
      expect(runRow(w, runId!)).toMatchObject({ status: 'killed', failure_class: 'killed' });
      expect(leaseStatuses(w, runId!)).toEqual(['released']);
      const ends = eventsOf(w, runId!).filter((e) => ['run.failed', 'run.killed'].includes(e.type));
      expect(ends).toHaveLength(1);
      expect(JSON.parse(ends[0]!.payload)).toMatchObject({
        cause: 'interrupted',
        detail: expect.stringMatching(/^interrupted/),
      });
      const stop = w.db((r) =>
        r.get<{ payload: string }>(
          "SELECT payload FROM events WHERE type = 'system.stopped' ORDER BY seq DESC",
        ),
      );
      expect(JSON.parse(stop!.payload)).toMatchObject({ clean: true, runs_interrupted: 1 });

      const dbFile = join(w.home, 'db/fw.sqlite');
      const before = readFileSync(dbFile);
      const head = w.db((r) => r.get<{ s: number }>('SELECT MAX(seq) AS s FROM events')!.s);
      const down = fwAsync(['status', '--json']);
      expect(await down.code).toBe(0);
      expect(JSON.parse(down.out())).toMatchObject({
        daemon: 'down',
        source: 'database',
        started_at: null,
        chain: { ok: true, head_seq: head },
      });
      expect(readFileSync(dbFile).equals(before)).toBe(true);
    } finally {
      if (!stopped) await d.stop('test done');
    }
  }, 90_000);
});
