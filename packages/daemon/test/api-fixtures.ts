// Fixtures for the fwd API tests: a temp FW_HOME seeded through the Writer, an HTTP client that
// controls every header (Host included), and helpers to run fwd as a child process.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore, sha256Hex, type Writer } from '@fw/eventlog';
import { ensureFwHome } from '../src/daemon.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const BIN = resolve(import.meta.dirname, '../src/bin.ts');

export const H64 = (c: string) => c.repeat(64).slice(0, 64);
export const SHA40 = 'c'.repeat(40);
export const FUTURE = '2999-01-01T00:00:00.000Z';
export const PAST = '2000-01-01T00:00:00.000Z';
export const DIFF_TEXT = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+new\n+more\n+lines\n';

export function tempHome(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'fwd-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function withWriter<T>(fwHome: string, fn: (w: Writer) => T): T {
  ensureFwHome(fwHome);
  const store = openStore({ path: join(fwHome, 'db', 'fw.sqlite'), lockPath: join(fwHome, 'fwd.lock') });
  try {
    return store.writer!.transaction(fn);
  } finally {
    store.close();
  }
}

function insert(w: Writer, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  w.run(
    `INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`,
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]),
    ),
  );
}

function ledgerRow(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    project_id: 'prj_test0001',
    stream_id: 'stm_test0001',
    priority: 'P1',
    lane: 'kernel',
    size: 'M',
    owner_kind: 'agent',
    owner_id: 'agt_work0001',
    probe_kind: 'command',
    probe_spec: { cmd: 'pnpm probe kernel/x' },
    probe_expected: { exit_code: 0 },
    probe_measures: 'the daemon answers on loopback',
    probe_hash: H64('a'),
    links: ['https://git.example.invalid/x'],
    ...extra,
  };
}

export const IDS = {
  project: 'prj_test0001',
  row: 'lr_FWC019',
  rowCode: 'FW-C-019',
  row2: 'lr_WSP1001',
  row2Code: 'WS-P1-001',
  row3: 'lr_FWC020',
  wo: 'wo_test0001',
  run: 'run_test0001',
  run2: 'run_test0002',
  orphan: 'run_test0003',
  bundle: 'evb_test0001',
  bundleNoDiff: 'evb_test0002',
  approval: 'apr_test0001',
  card: 'dcd_test0001',
  card2: 'dcd_test0002',
  card3: 'dcd_test0003',
  lease: 'lse_test0001',
  orphanLease: 'lse_test0003',
  staleLease: 'lse_test0009',
} as const;

/**
 * Seeds a project, agents, a stream, three ledger rows, a work order, three runs (one paused with
 * a live lease, one failed, one left `running` as an orphan), steps, artifacts, two evidence
 * bundles (one with a stored diff), an approval, cards, a budget, spend and a status report.
 */
export function seed(fwHome: string): void {
  mkdirSync(join(fwHome, 'runs', IDS.run), { recursive: true });
  writeFileSync(join(fwHome, 'runs', IDS.run, 'diff.patch'), DIFF_TEXT);
  const now = new Date().toISOString();
  withWriter(fwHome, (w) => {
    insert(w, 'projects', {
      id: IDS.project,
      slug: 'atlas',
      name: 'Atlas',
      repo_url: 'https://git.example.invalid/atlas',
    });
    insert(w, 'agents', {
      id: 'agt_work0001',
      name: 'worker',
      role: 'worker',
      vendor: 'local',
      model: 'fake',
      tier: 'L2',
      status: 'active',
    });
    insert(w, 'agents', {
      id: 'agt_veri0001',
      name: 'verifier',
      role: 'verifier',
      vendor: 'local',
      model: 'fake',
      tier: 'L1',
      status: 'active',
    });
    insert(w, 'agents', {
      id: 'agt_lead0001',
      name: 'chief',
      role: 'chief_of_staff',
      vendor: 'local',
      model: 'fake',
      tier: 'L1',
      status: 'active',
    });
    insert(w, 'streams', {
      id: 'stm_test0001',
      project_id: IDS.project,
      key: 'dev',
      name: 'Backlog dev',
      template: 'backlog_dev',
      definition: { key: 'dev' },
      definition_hash: H64('b'),
      status: 'active',
    });
    insert(
      w,
      'ledger_rows',
      ledgerRow(IDS.row, {
        title: 'Web shell: pairing and status strip',
        priority: 'P0',
        status: 'running',
        wave: 'C2',
        last_probe_status: 'fail',
      }),
    );
    insert(w, 'ledger_rows', ledgerRow(IDS.row2, { title: 'Control-plane daemon skeleton', wave: 'C1' }));
    insert(
      w,
      'ledger_rows',
      ledgerRow(IDS.row3, { title: 'Captain table inbox', priority: 'P2', status: 'blocked', wave: 'C2' }),
    );
    insert(w, 'work_orders', {
      id: IDS.wo,
      project_id: IDS.project,
      stream_id: 'stm_test0001',
      ledger_row_id: IDS.row,
      title: 'Build the web shell',
      body: { budget: { caps: { max_usd: 5 } } },
      content_hash: H64('c'),
      autonomy_tier: 'L2',
      doer_agent_id: 'agt_work0001',
      verifier_agent_id: 'agt_veri0001',
      status: 'running',
      issued_at: now,
      expires_at: FUTURE,
    });
    const lease = (id: string, key: string, run: string, fence: number, expires = FUTURE) =>
      insert(w, 'leases', {
        id,
        resource_kind: 'worktree',
        resource_key: key,
        holder_agent_id: 'agt_work0001',
        run_id: run,
        fence_token: fence,
        acquired_at: '2026-01-01T00:00:00.000Z',
        heartbeat_at: '2026-01-01T00:01:00.000Z',
        expires_at: expires,
      });
    lease(IDS.lease, 'wt-1', IDS.run, 1);
    lease(IDS.orphanLease, 'wt-3', IDS.orphan, 1);
    lease(IDS.staleLease, 'wt-9', 'run_gone', 1, '2026-01-01T00:05:00.000Z');
    const run = (id: string, attempt: number, extra: Record<string, unknown>) =>
      insert(w, 'runs', {
        id,
        work_order_id: IDS.wo,
        project_id: IDS.project,
        stream_id: 'stm_test0001',
        agent_id: 'agt_work0001',
        attempt,
        adapter_name: 'fake',
        adapter_vendor: 'local',
        queued_at: `2026-01-0${attempt}T00:00:00.000Z`,
        ...extra,
      });
    run(IDS.run, 1, {
      status: 'paused',
      lease_id: IDS.lease,
      started_at: now,
      cost_usd: 0.75,
      branch: 'row/FW-C-019',
    });
    run(IDS.run2, 2, { status: 'failed', failure_class: 'nonzero_exit', exit_code: 2, ended_at: now });
    run(IDS.orphan, 3, { status: 'running', lease_id: IDS.orphanLease, started_at: now });
    const kinds = ['prompt', 'model_turn', 'tool_call'] as const;
    kinds.forEach((kind, seq) => {
      insert(w, 'run_steps', { id: `stp_test000${seq}`, run_id: IDS.run, seq, kind, started_at: now });
    });
    insert(w, 'run_artifacts', {
      run_id: IDS.run,
      kind: 'pull_request',
      ref: 'https://git.example.invalid/atlas/pull/12',
      sha: SHA40,
      verified_by_kernel: 1,
      verified_at: now,
    });
    insert(w, 'evidence_bundles', {
      id: IDS.bundle,
      subject_kind: 'run',
      subject_ref: IDS.run,
      subject_sha: SHA40,
      body: {
        probe: { exit_code: 1, output_tail: 'FAIL', duration_ms: 12 },
        diff: { hash: sha256Hex(DIFF_TEXT), files: [{ path: 'src/a.ts', added: 3, removed: 1 }] },
        sandbox: { level: 'best_effort', controls: {} },
        adapter: { name: 'fake', version: '0.0.0', help_sha256: H64('d') },
      },
      bundle_hash: H64('e'),
      captured_by: 'kernel',
    });
    insert(w, 'evidence_bundles', {
      id: IDS.bundleNoDiff,
      subject_kind: 'ledger_row',
      subject_ref: IDS.row2,
      body: { probe: { exit_code: 0 } },
      bundle_hash: H64('f'),
      captured_by: 'kernel',
    });
    insert(w, 'approvals', {
      id: IDS.approval,
      action_class: 'code_write_sandbox',
      environment: 'sandbox',
      tier: 'L2',
      subject_kind: 'run',
      subject_ref: IDS.run,
      payload_hash: sha256Hex(DIFF_TEXT),
      head_sha: SHA40,
      evidence_bundle_id: IDS.bundle,
      requester_agent_id: 'agt_work0001',
      request: { work_order_id: IDS.wo },
      expires_at: FUTURE,
    });
    insert(w, 'decision_cards', {
      id: IDS.card,
      variant: 'approve',
      project_id: IDS.project,
      title: 'Approve the shell',
      ask: 'Approve?',
      urgency: 'today',
      default_on_timeout: 'deny',
      approval_id: IDS.approval,
      evidence_bundle_id: IDS.bundle,
      body: { source: { ledger_row_id: IDS.row, run_id: IDS.run } },
    });
    insert(w, 'decision_cards', {
      id: IDS.card2,
      variant: 'answer',
      title: 'Which port?',
      ask: 'Pick a port',
      urgency: 'now',
      default_on_timeout: 'none',
      body: {},
    });
    insert(w, 'decision_cards', {
      id: IDS.card3,
      variant: 'answer',
      title: 'Old question',
      ask: 'Withdrawn',
      urgency: 'whenever',
      default_on_timeout: 'none',
      body: {},
      status: 'withdrawn',
    });
    insert(w, 'budgets', {
      id: 'bud_fleet001',
      scope_kind: 'fleet',
      scope_id: 'fleet',
      period: 'day',
      max_usd: 20,
      set_by: 'own_local',
    });
    insert(w, 'spend_entries', {
      id: 'spd_test0001',
      project_id: IDS.project,
      run_id: IDS.run,
      agent_id: 'agt_work0001',
      kind: 'model_tokens',
      vendor: 'local',
      usd: 0.5,
      tokens_in: 100,
      idempotency_key: 's1',
    });
    insert(w, 'spend_entries', {
      id: 'spd_test0002',
      project_id: IDS.project,
      run_id: IDS.run,
      agent_id: 'agt_work0001',
      kind: 'model_tokens',
      vendor: 'local',
      usd: 0.25,
      tokens_in: 50,
      idempotency_key: 's2',
    });
    insert(w, 'status_reports', {
      id: 'rpt_test0001',
      reporter_agent_id: 'agt_lead0001',
      project_id: IDS.project,
      kind: 'daily',
      period_from: '2026-11-08T00:00:00.000Z',
      period_to: '2026-11-09T00:00:00.000Z',
      body: { self_check: { passed: true, failed_query_ids: [] } },
      data_as_of: now,
    });
    for (const id of [IDS.row, IDS.row2, IDS.row3]) {
      w.appendEvent({
        type: 'ledger.row_created',
        actor_kind: 'system',
        actor_id: 'test',
        project_id: IDS.project,
        payload: { ledger_row_id: id },
      });
    }
    w.appendEvent({
      type: 'run.started',
      actor_kind: 'system',
      actor_id: 'test',
      run_id: IDS.run,
      payload: { run_id: IDS.run, sandbox_level: 'best_effort' },
    });
  });
}

// ---- HTTP ---------------------------------------------------------------------------------

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected structurally
  json: any;
}

export function call(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  return new Promise((ok, fail) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          ok({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---- child processes -------------------------------------------------------------------------

export interface Child {
  proc: ChildProcess;
  out: () => string;
  waitFor: (re: RegExp, ms?: number) => Promise<RegExpMatchArray>;
  exited: Promise<number | null>;
}

/** Runs a TypeScript entry point under node --import tsx (one process, so kill -9 hits the daemon). */
export function spawnTs(file: string, args: string[], env: Record<string, string> = {}): Child {
  const proc = spawn(process.execPath, ['--import', 'tsx', file, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, FW_DEV_NO_AUTH: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout!.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
  });
  proc.stderr!.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
  });
  const exited = new Promise<number | null>((ok) => proc.on('exit', (code) => ok(code)));
  const waitFor = (re: RegExp, ms = 20_000) =>
    new Promise<RegExpMatchArray>((ok, fail) => {
      const started = Date.now();
      const tick = () => {
        const m = buf.match(re);
        if (m) return ok(m);
        if (proc.exitCode !== null || Date.now() - started > ms) {
          return fail(new Error(`timed out waiting for ${re}; output so far:\n${buf}`));
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  return { proc, out: () => buf, waitFor, exited };
}
