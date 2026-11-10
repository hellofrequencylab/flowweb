// fwd local API v1 (docs/api/LOCAL-API-V1.md): envelopes, derived fields, filters, paging, 404s,
// the 501 write routes, the startup reconciler and SSE. Auth is off here (devNoAuth); auth.test.ts covers it.
import { request } from 'node:http';
import { sha256Hex } from '@fw/eventlog';
import { labelProject } from '@fw/ledger';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.ts';
import { call, DIFF_TEXT, IDS, type Res, seed, tempHome } from './api-fixtures.ts';

const home = tempHome();
let d: Daemon;
const get = (path: string, headers: Record<string, string> = {}) =>
  call(d.port, 'GET', `/v1${path}`, { headers });

function expectEnvelope(res: Res): void {
  expect(res.status).toBe(200);
  expect(Object.keys(res.json).sort()).toEqual(['as_of', 'data', 'head_seq', 'next_cursor']);
  expect(new Date(res.json.as_of).toISOString()).toBe(res.json.as_of);
  expect(Number.isInteger(res.json.head_seq)).toBe(true);
}

beforeAll(async () => {
  seed(home.path);
  d = await startDaemon({
    fwHome: home.path,
    port: 0,
    devNoAuth: true,
    ssePollMs: 25,
    sseHeartbeatMs: 200,
    log: () => {},
    // The supervisor's job after the reconciler: resume the paused run so one run is live.
    beforeListen: (w) => {
      w.run("UPDATE runs SET status = 'running' WHERE id = ?", [IDS.run]);
    },
  });
});

afterAll(async () => {
  await d?.stop('test done');
  home.cleanup();
});

describe('startup', () => {
  test('appends system.started and runs the reconciler first', async () => {
    const res = await get('/events?type=system.started');
    expectEnvelope(res);
    expect(res.json.data).toHaveLength(1);
    expect(res.json.data[0].payload.genesis).toBe(false);
    const rec = await get('/events?type=reconciler.completed');
    expect(rec.json.data[0].payload).toMatchObject({
      scope: 'startup',
      runs_failed: [IDS.orphan],
      leases_released: [IDS.orphanLease],
      leases_expired: [IDS.staleLease],
    });
  });

  test('the orphaned running run is failed with failure_class killed and its lease released', async () => {
    const run = (await get(`/runs/${IDS.orphan}`)).json.data;
    expect(run.status).toBe('failed');
    expect(run.failure_class).toBe('killed');
    expect(run.ended_at).toBeTruthy();
    const failed = (await get(`/events?type=run.failed&run_id=${IDS.orphan}`)).json.data;
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.previous_status).toBe('running');
    // FW-C-029: the reason says the run was interrupted, so a restart after a crash reads as one.
    expect(failed[0].payload.detail).toMatch(/^interrupted: /);
    const leases = d.writer.all<{ id: string; status: string }>('SELECT id, status FROM leases ORDER BY id');
    expect(Object.fromEntries(leases.map((l) => [l.id, l.status]))).toEqual({
      [IDS.lease]: 'active',
      [IDS.orphanLease]: 'released',
      [IDS.staleLease]: 'expired',
    });
  });
});

describe('GET /v1/status', () => {
  test('fills what C0 can know and nulls the rest', async () => {
    const res = await get('/status');
    expectEnvelope(res);
    const s = res.json.data;
    expect(s.daemon).toBe('up');
    expect(s.version).toBe('0.0.0');
    expect(s.started_at).toBe(d.startedAt);
    expect(s.kill).toEqual({
      engaged: false,
      engaged_at: null,
      reason: null,
      runs_to_halt: null,
      runs_halted: null,
      keys_revoked: null,
    });
    expect(s.chain.ok).toBe(true);
    expect(s.chain.head_seq).toBeGreaterThan(0);
    expect(s.chain.head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.chain.failed_seq).toBeNull();
    expect(s.spend).toEqual({ today_usd: 0.75, daily_cap_usd: 20, vendors_reporting: ['local'] });
    expect(s.breaker).toEqual({ tripped: false, reason: null });
    expect(s.paused_by_budget).toBe(false);
    expect(s.sandbox_level).toBe('best_effort');
    expect(s.open_cards).toBe(2);
    expect(typeof s.oldest_open_card_at).toBe('string');
    expect(s.running_runs).toBe(1);
  });

  test('head_seq is the event log head at read time', async () => {
    const res = await get('/status');
    const head = d.writer.get<{ s: number }>('SELECT MAX(seq) AS s FROM events')!.s;
    expect(res.json.head_seq).toBe(head);
  });
});

describe('projects and ledger', () => {
  test('projects carry row counts; a row carries last_run_id and its events', async () => {
    const p = (await get('/projects')).json.data[0];
    for (const k of ['rows_open', 'rows_in_progress', 'rows_waiting_on_owner'])
      expect(typeof p[k]).toBe('number');
    const row = (await get(`/ledger/rows/${IDS.rowCode}`)).json.data;
    expect(row.last_run_id).toBe(row.runs[0].id);
    expect(Array.isArray(row.events)).toBe(true);
  });

  test('/projects and /projects/{id}', async () => {
    const list = await get('/projects');
    expectEnvelope(list);
    expect(list.json.data.map((p: { id: string }) => p.id)).toEqual([IDS.project]);
    expect((await get(`/projects/${IDS.project}`)).json.data.slug).toBe('atlas');
    const miss = await get('/projects/prj_nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error.code).toBe('not_found');
  });

  test('projects carry brand and category, and filter by them', async () => {
    const before = (await get(`/projects/${IDS.project}`)).json.data;
    expect([before.brand, before.category]).toEqual([null, null]);
    labelProject(d.writer, IDS.project, { brand: 'Frequency', category: 'marketing' });
    const after = (await get(`/projects/${IDS.project}`)).json.data;
    expect([after.brand, after.category]).toEqual(['Frequency', 'marketing']);
    const ids = async (q: string) => (await get(`/projects?${q}`)).json.data.map((p: { id: string }) => p.id);
    expect(await ids('brand=frequency')).toEqual([IDS.project]);
    expect(await ids('category=marketing')).toEqual([IDS.project]);
    expect(await ids('brand=Other')).toEqual([]);
    expect(await ids('category=ops')).toEqual([]);
    labelProject(d.writer, IDS.project, { brand: null, category: null });
  });

  test('ledger rows carry code and parsed JSON columns, unchanged column names', async () => {
    const res = await get('/ledger/rows');
    expectEnvelope(res);
    const rows = res.json.data as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.code)).toEqual(['FW-C-019', 'WS-P1-001', 'FW-C-020']);
    const r0 = rows[0]!;
    expect(r0.id).toBe(IDS.row);
    expect(r0.probe_spec).toEqual({ cmd: 'pnpm probe kernel/x' });
    expect(r0.probe_expected).toEqual({ exit_code: 0 });
    expect(r0.links).toEqual(['https://git.example.invalid/x']);
    expect(r0.depends_on).toEqual([]);
    expect(r0).toHaveProperty('last_probe_status', 'fail');
    expect(r0).toHaveProperty('wave', 'C2');
  });

  test('filters: status, milestone (wave), q, project_id', async () => {
    const ids = async (qs: string) =>
      ((await get(`/ledger/rows?${qs}`)).json.data as Array<{ id: string }>).map((r) => r.id);
    expect(await ids('status=blocked')).toEqual([IDS.row3]);
    expect(await ids('milestone=C2')).toEqual([IDS.row, IDS.row3]);
    expect(await ids('q=daemon')).toEqual([IDS.row2]);
    expect(await ids('q=WS-P1-001')).toEqual([IDS.row2]);
    expect(await ids('project_id=prj_other')).toEqual([]);
    expect(await ids(`project_id=${IDS.project}&milestone=C1`)).toEqual([IDS.row2]);
    const bad = await get('/ledger/rows?status=nope');
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation_failed');
  });

  test('paging with limit and an opaque cursor', async () => {
    const p1 = await get('/ledger/rows?limit=2');
    expect(p1.json.data).toHaveLength(2);
    expect(typeof p1.json.next_cursor).toBe('string');
    const p2 = await get(`/ledger/rows?limit=2&cursor=${p1.json.next_cursor}`);
    expect(p2.json.data.map((r: { id: string }) => r.id)).toEqual([IDS.row3]);
    expect(p2.json.next_cursor).toBeNull();
    expect((await get('/ledger/rows?limit=0')).status).toBe(400);
    expect((await get('/ledger/rows?cursor=garbage')).status).toBe(400);
    expect((await get('/ledger/rows?limit=5000')).json.data).toHaveLength(3); // capped at 200, not refused
  });

  test('/ledger/rows/{id} accepts the lr_ id or the code, with evidence and runs', async () => {
    const byId = await get(`/ledger/rows/${IDS.row}`);
    const byCode = await get(`/ledger/rows/${IDS.rowCode}`);
    expectEnvelope(byCode);
    expect(byCode.json.data).toEqual(byId.json.data);
    const row = byCode.json.data;
    expect(row.code).toBe('FW-C-019');
    expect(row.evidence.map((e: { id: string }) => e.id)).toEqual([IDS.bundle]);
    expect(row.evidence[0].body.diff.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 1 }]);
    expect(row.runs.map((r: { id: string }) => r.id)).toEqual([IDS.orphan, IDS.run2, IDS.run]);
    expect(row.runs.every((r: { row_code: string }) => r.row_code === 'FW-C-019')).toBe(true);
    expect(
      (await get(`/ledger/rows/${IDS.row2Code}`)).json.data.evidence.map((e: { id: string }) => e.id),
    ).toEqual([IDS.bundleNoDiff]);
    expect((await get('/ledger/rows/FW-C-999')).status).toBe(404);
  });
});

describe('runs', () => {
  test('runs carry row_code, last_heartbeat_at from the lease, cost_usd and sandbox_level', async () => {
    const res = await get(`/runs/${IDS.run}`);
    expectEnvelope(res);
    const run = res.json.data;
    expect(run.status).toBe('running');
    expect(run.row_code).toBe('FW-C-019');
    expect(run.last_heartbeat_at).toBe('2026-01-01T00:01:00.000Z');
    expect(run.cost_usd).toBe(0.75);
    expect(run.sandbox_level).toBe('best_effort');
    expect(run).not.toHaveProperty('_ledger_row_id');
    expect((await get('/runs/run_nope')).status).toBe(404);
  });

  test('a run lists its artifacts and says whether the kernel verified one', async () => {
    const run = (await get(`/runs/${IDS.run}`)).json.data;
    expect(run.artifact_verified).toBe(true);
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]).toMatchObject({ kind: 'pull_request', verified_by_kernel: true });
    expect((await get(`/runs/${IDS.run2}`)).json.data.artifact_verified).toBe(false);
  });

  test('filters by status and row_id (id or code)', async () => {
    const ids = async (qs: string) =>
      ((await get(`/runs?${qs}`)).json.data as Array<{ id: string }>).map((r) => r.id);
    expect(await ids('status=failed')).toEqual([IDS.orphan, IDS.run2]);
    expect(await ids(`row_id=${IDS.rowCode}`)).toHaveLength(3);
    expect(await ids(`row_id=${IDS.row2}`)).toEqual([]);
  });

  test('/runs/{id}/steps in seq order', async () => {
    const res = await get(`/runs/${IDS.run}/steps`);
    expectEnvelope(res);
    expect(res.json.data.map((s: { seq: number; kind: string }) => [s.seq, s.kind])).toEqual([
      [0, 'prompt'],
      [1, 'model_turn'],
      [2, 'tool_call'],
    ]);
    expect((await get('/runs/run_nope/steps')).status).toBe(404);
  });
});

describe('evidence', () => {
  test('/evidence-bundles/{id} parses body (also offered as bundle)', async () => {
    const res = await get(`/evidence-bundles/${IDS.bundle}`);
    expectEnvelope(res);
    expect(res.json.data.body.sandbox.level).toBe('best_effort');
    expect(res.json.data.bundle).toEqual(res.json.data.body);
    expect((await get('/evidence-bundles/evb_nope')).status).toBe(404);
  });

  test('/diff serves the exact stored bytes whose sha256 is bundle.diff.hash', async () => {
    const res = await get(`/evidence-bundles/${IDS.bundle}/diff`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/x-diff');
    expect(res.text).toBe(DIFF_TEXT);
    expect(sha256Hex(res.text)).toBe(res.headers['x-fw-sha256']);
    const none = await get(`/evidence-bundles/${IDS.bundleNoDiff}/diff`);
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe('not_found');
  });
});

describe('events', () => {
  test('after_seq, type (exact and prefix) and run_id filters, payload parsed', async () => {
    const all = (await get('/events?limit=200')).json.data as Array<{ seq: number; type: string }>;
    expect(all[0]!.seq).toBe(1);
    const after = (await get('/events?after_seq=2')).json.data;
    expect(after[0].seq).toBe(3);
    const created = (await get('/events?type=ledger.row_created')).json.data;
    expect(created).toHaveLength(3);
    expect(created[0].payload.ledger_row_id).toBe(IDS.row);
    const runEvents = (await get('/events?type=run.*')).json.data as Array<{ type: string }>;
    expect(runEvents.length).toBeGreaterThan(0);
    expect(runEvents.every((e) => e.type.startsWith('run.'))).toBe(true);
    const byRun = (await get(`/events?run_id=${IDS.run}`)).json.data as Array<{ run_id: string }>;
    expect(byRun.every((e) => e.run_id === IDS.run)).toBe(true);
  });

  test('pages by seq', async () => {
    const p1 = await get('/events?limit=2');
    expect(p1.json.next_cursor).toBe(String(p1.json.data[1].seq));
    const p2 = await get(`/events?limit=2&cursor=${p1.json.next_cursor}`);
    expect(p2.json.data[0].seq).toBe(p1.json.data[1].seq + 1);
  });
});

describe('spend, budgets, cards, approvals, reports, policy', () => {
  test('/spend aggregates by project, agent or vendor', async () => {
    const res = await get('/spend?group_by=vendor');
    expectEnvelope(res);
    expect(res.json.data).toEqual([expect.objectContaining({ vendor: 'local', usd: 0.75, entries: 2 })]);
    const byProject = (await get('/spend')).json.data;
    expect(byProject[0]).toMatchObject({ project_id: IDS.project, usd: 0.75, tokens_in: 150 });
    expect((await get('/spend?from=2999-01-01T00:00:00Z')).json.data).toEqual([]);
    expect((await get('/spend?group_by=moon')).status).toBe(400);
  });

  test('/budgets include spent_usd from budget_usage', async () => {
    const res = await get('/budgets');
    expect(res.json.data).toEqual([
      expect.objectContaining({ id: 'bud_fleet001', max_usd: 20, spent_usd: 0.75, body: {} }),
    ]);
  });

  test('/decision-cards orders by urgency then deadline and filters by status', async () => {
    const open = await get('/decision-cards?status=open');
    expectEnvelope(open);
    expect(open.json.data.map((c: { id: string }) => c.id)).toEqual([IDS.card2, IDS.card]);
    expect(open.json.data[1].row_code).toBe('FW-C-019');
    expect(open.json.data[0].row_code).toBeNull();
    expect((await get('/decision-cards')).json.data).toHaveLength(3);
  });

  test('/decision-cards/{id} adds approval, pr, merge_slot, policy and files', async () => {
    const card = (await get(`/decision-cards/${IDS.card}`)).json.data;
    expect(card.approval).toEqual({
      payload_hash: sha256Hex(DIFF_TEXT),
      head_sha: 'c'.repeat(40),
      expires_at: '2999-01-01T00:00:00.000Z',
      status: 'pending',
    });
    expect(card.pr).toMatchObject({ url: 'https://git.example.invalid/atlas/pull/12', number: 12 });
    expect(card.merge_slot).toBeNull();
    expect(card.policy).toBeNull();
    expect(card.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 1 }]);
    expect((await get('/decision-cards/dcd_nope')).status).toBe(404);
  });

  test('/approvals/{id} parses request', async () => {
    const res = await get(`/approvals/${IDS.approval}`);
    expect(res.json.data.request).toEqual({ work_order_id: IDS.wo });
    expect(res.json.data.status).toBe('pending');
    expect((await get('/approvals/apr_nope')).status).toBe(404);
  });

  test('/status-reports?kind=daily&limit=1 parses body', async () => {
    const res = await get('/status-reports?kind=daily&limit=1');
    expect(res.json.data[0].body.self_check).toEqual({ passed: true, failed_query_ids: [] });
  });

  test('/policy returns path, commit, sha256 and text', async () => {
    const res = await get('/policy');
    const p = res.json.data;
    expect(p.path).toMatch(/core-policy\.yaml$/);
    expect(p.sha256).toBe(sha256Hex(p.text));
    expect(p.text).toContain('policy_version');
    expect(p.commit === null || /^[0-9a-f]{40}$/.test(p.commit)).toBe(true);
  });

  test('/flows/local-saturation returns the rings, the next move and the budget; other keys are 404', async () => {
    const res = await get('/flows/local-saturation');
    expect(res.status).toBe(200);
    const f = res.json.data;
    expect(f.key).toBe('local-saturation');
    expect(f.rings[0].open).toBe(true);
    expect(f.decision.kind).toBe('keep_working');
    expect(f.budget.max_usd).toBe(5);
    expect(f.gate_on).toEqual(['publish_external', 'outbound_email_external']);
    expect((await get('/flows/other')).status).toBe(404);
  });

  test('/flows/neighborhood-activation returns the territories, the next move and the budget', async () => {
    const res = await get('/flows/neighborhood-activation');
    expect(res.status).toBe(200);
    const f = res.json.data;
    expect(f.key).toBe('neighborhood-activation');
    expect(f.territories[0]).toMatchObject({ id: 'north-county-sd', status: 'active', measures: null });
    expect(f.decision.kind).toBe('keep_working');
    expect(f.budget.max_usd).toBe(5);
  });
});

describe('errors', () => {
  test('unknown route is 404 not_found; contract writes are 501 with the row that adds them', async () => {
    const miss = await get('/nope');
    expect(miss.status).toBe(404);
    expect(miss.json).toEqual({ error: { code: 'not_found', message: expect.any(String), details: {} } });
    const kill = await call(d.port, 'POST', '/v1/kill-switch', { body: { reason: 'x' } });
    expect(kill.status).toBe(501);
    expect(kill.json.error).toMatchObject({
      code: 'not_implemented',
      details: { row: 'FW-C-012', milestone: 'C1' },
    });
    const respond = await call(d.port, 'POST', `/v1/approvals/${IDS.approval}/respond`, { body: {} });
    expect(respond.json.error.details.row).toBe('FW-C-010');
    expect((await call(d.port, 'DELETE', '/v1/session')).status).toBe(501);
  });
});

describe('POST /v1/runs', () => {
  const post = (body: unknown) => call(d.port, 'POST', '/v1/runs', { body });

  test('checks the body before any run starts', async () => {
    for (const [body, message] of [
      [{ repo_dir: '/tmp' }, /code is required/],
      [{ code: 'FW-C-001' }, /repo_dir is required/],
      [{ code: 'FW-C-001', repo_dir: 'relative/dir' }, /absolute/],
      [{ code: 'FW-C-001', repo_dir: '/tmp', max_wall_clock_s: 0 }, /positive whole number/],
      [{ code: 'FW-C-001', repo_dir: '/tmp', surprise: true }, /unknown field/],
    ] as const) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe('validation_failed');
      expect(res.json.error.message).toMatch(message);
    }
    expect(d.runs.size).toBe(0);
  });

  test('a kernel error keeps its own code in details.fw_code', async () => {
    const res = await post({ code: 'FW-Z-999', repo_dir: '/tmp' });
    expect(res.status).toBe(404);
    expect(res.json.error).toMatchObject({ code: 'not_found', details: { fw_code: 'NOT_FOUND' } });
  });
});

describe('GET /v1/events/stream (SSE)', () => {
  interface Sse {
    text: () => string;
    close: () => void;
    until: (re: RegExp) => Promise<void>;
  }
  function open(headers: Record<string, string> = {}, qs = ''): Promise<Sse> {
    return new Promise((ok, fail) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: d.port,
          path: `/v1/events/stream${qs}`,
          headers: { host: `127.0.0.1:${d.port}`, ...headers },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
          let buf = '';
          res.on('data', (c: Buffer) => {
            buf += c.toString('utf8');
          });
          ok({
            text: () => buf,
            close: () => req.destroy(),
            until: (re) =>
              new Promise((done, bad) => {
                const t0 = Date.now();
                const tick = () => {
                  if (re.test(buf)) return done();
                  if (Date.now() - t0 > 5000) return bad(new Error(`no ${re} in:\n${buf}`));
                  setTimeout(tick, 20);
                };
                tick();
              }),
          });
        },
      );
      req.on('error', fail);
      req.end();
    });
  }

  test('delivers a newly appended event with id = seq, and heartbeats', async () => {
    const s = await open();
    const ev = d.writer.appendEvent({
      type: 'system.config_changed',
      actor_kind: 'system',
      actor_id: 'test',
      payload: { key: 'sse.test', n: 1 },
    });
    await s.until(new RegExp(`id: ${ev.seq}\\nevent: fw\\ndata: `));
    const line = s
      .text()
      .split('\n')
      .find((l) => l.startsWith('data: ') && l.includes('sse.test'))!;
    const data = JSON.parse(line.slice(6));
    expect(data).toMatchObject({
      seq: ev.seq,
      type: 'system.config_changed',
      payload: { key: 'sse.test', n: 1 },
    });
    await s.until(/: heartbeat\n\n/);
    s.close();
  });

  test('resumes after Last-Event-ID without gaps or duplicates', async () => {
    const head = d.writer.get<{ s: number }>('SELECT MAX(seq) AS s FROM events')!.s;
    const from = head - 3;
    const s = await open({ 'last-event-id': String(from) });
    await s.until(new RegExp(`id: ${head}\\n`));
    const ids = [...s.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([from + 1, from + 2, from + 3]);
    s.close();
    const bad = await get('/events/stream', { 'last-event-id': 'x' });
    expect(bad.status).toBe(400);
  });
});
