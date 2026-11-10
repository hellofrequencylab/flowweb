// WS-P0-040: work order compiler and fw wo issue.
import { join } from 'node:path';
import { validate } from '@fw/contracts';
import { describe, expect, test } from 'vitest';
import {
  briefProject,
  type CompileInput,
  compileWorkOrder,
  DEFAULT_AGENTS,
  getDbRow,
  issueWorkOrder,
  loadCorePolicy,
  probeFromDefinition,
  retestPremise,
} from '../src/index.ts';
import { fileStore, fwHome, gitRepo, REPO_ROOT, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();
const home = fwHome(dir);

async function readyRow(name: string, extra: Parameters<typeof row>[1] = {}) {
  const store = fileStore(dir, `${name}.sqlite`);
  const rowsDir = writeRows(join(dir, `${name}-rows`), [row('FW-C-940', extra)]);
  syncInto(store, rowsDir);
  const repo = gitRepo(dir, `${name}-repo`);
  await retestPremise(store.writer!, 'FW-C-940', { repoDir: repo.dir });
  return { store, w: store.writer!, repo, rowsDir };
}

describe('fw wo issue', () => {
  test('issues a schema-valid order: worker doer, named verifier, caps and TTL from the size table', async () => {
    const { store, w, repo, rowsDir } = await readyRow('issue');
    const r = issueWorkOrder(w, 'FW-C-940', { repoDir: repo.dir, home, rowsDir });
    expect(validate('work-order', r.work_order).errors).toEqual([]);
    expect(r.work_order).toMatchObject({
      ledger_row_id: 'lr_FWC940',
      base_commit: repo.base,
      autonomy_tier: 'L2',
      roles: {
        doer: DEFAULT_AGENTS.worker.id,
        verifier: DEFAULT_AGENTS.verifier.id,
        approver: { kind: 'owner', id: 'own_local' },
      },
      budget: { caps: { max_usd: 1.5, max_minutes: 30, max_turns: 60, max_tokens: 1000000 }, ttl_hours: 24 },
      scope: { touches: ['src/**'] },
      acceptance: [
        {
          id: 'AC1',
          claim: 'The marker file exists after the change',
          probe_command: 'sh check.sh',
          expected: 'exit 0',
        },
      ],
    });
    expect(r.work_order.scope.forbidden).toEqual(
      expect.arrayContaining(['probes/**', 'ledger/rows/**', 'AGENTS.md']),
    );
    const db = store
      .reader()
      .get<{ status: string; content_hash: string; doer_agent_id: string; verifier_agent_id: string }>(
        'SELECT status, content_hash, doer_agent_id, verifier_agent_id FROM work_orders WHERE id = ?',
        [r.work_order_id],
      );
    expect(db).toEqual({
      status: 'issued',
      content_hash: r.content_hash,
      doer_agent_id: DEFAULT_AGENTS.worker.id,
      verifier_agent_id: DEFAULT_AGENTS.verifier.id,
    });
    const types = store
      .reader()
      .all<{ type: string }>("SELECT type FROM events WHERE type LIKE 'work_order.%' ORDER BY seq")
      .map((e) => e.type);
    expect(types).toEqual(['work_order.drafted', 'work_order.issued']);
    expect(() => issueWorkOrder(w, 'FW-C-940', { repoDir: repo.dir, home, rowsDir })).toThrow(
      /already has work order/,
    );
    store.close();
  });

  test('FW-C-040: an order carries the project brief once the Owner saves one', async () => {
    const { store, w, repo, rowsDir } = await readyRow('brief');
    const projectId = getDbRow(w, 'FW-C-940')!.project_id;
    const slug = w.get<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', [projectId])!.slug;
    briefProject(w, slug, { what: 'W', who: 'Who', voice: 'Calm', never: 'Never X', done: 'Done Y' });
    const r = issueWorkOrder(w, 'FW-C-940', { repoDir: repo.dir, home, rowsDir });
    expect(r.work_order.constraints.style).toEqual(["Voice, from the Owner's project brief: Calm"]);
    expect(r.work_order.constraints.notes).toContain('What the agents must never do on it: Never X');
    store.close();
  });

  test('self-verification is refused', async () => {
    const { store, w, repo, rowsDir } = await readyRow('self');
    expect(() =>
      issueWorkOrder(w, 'FW-C-940', {
        repoDir: repo.dir,
        home,
        rowsDir,
        doer: DEFAULT_AGENTS.worker.id,
        verifier: DEFAULT_AGENTS.worker.id,
      }),
    ).toThrow(expect.objectContaining({ code: 'SELF_VERIFY' }));
    // A verifier that is not a verifier agent is refused too.
    expect(() =>
      issueWorkOrder(w, 'FW-C-940', { repoDir: repo.dir, home, rowsDir, verifier: DEFAULT_AGENTS.lead.id }),
    ).toThrow(expect.objectContaining({ code: 'AGENT_INVALID' }));
    expect(store.reader().get('SELECT COUNT(*) AS n FROM work_orders')).toEqual({ n: 0 });
    store.close();
  });

  test('an unready row is refused', () => {
    const store = fileStore(dir, 'unready.sqlite');
    const rowsDir = writeRows(join(dir, 'unready-rows'), [row('FW-C-941')]);
    syncInto(store, rowsDir);
    const repo = gitRepo(dir, 'unready-repo');
    expect(getDbRow(store.reader(), 'FW-C-941').status).toBe('open');
    expect(() => issueWorkOrder(store.writer!, 'FW-C-941', { repoDir: repo.dir, home, rowsDir })).toThrow(
      expect.objectContaining({ code: 'ROW_NOT_READY' }),
    );
    store.close();
  });

  test('an XL row is refused (not dispatchable in Core)', async () => {
    const { store, w, repo, rowsDir } = await readyRow('xl', { size: 'XL' });
    expect(() => issueWorkOrder(w, 'FW-C-940', { repoDir: repo.dir, home, rowsDir })).toThrow(
      expect.objectContaining({
        code: 'SIZE_NOT_DISPATCHABLE',
        message: expect.stringMatching(/size XL.*split the row/),
      }),
    );
    store.close();
  });
});

describe('compileWorkOrder', () => {
  const policy = loadCorePolicy(REPO_ROOT);
  const probe = probeFromDefinition({ id: 'FW-C-942', verify_probe: 'pnpm probe kernel/x' });
  const input: CompileInput = {
    id: 'wo_test000001',
    version: 1,
    issuedAt: new Date('2026-11-09T10:00:00.000Z'),
    row: {
      id: 'lr_FWC942',
      code: 'FW-C-942',
      title: 'A row',
      size: 'M',
      project_id: 'prj_test0001',
      stream_id: 'stm_test0001',
    },
    probe,
    baseCommit: 'a'.repeat(40),
    policy,
    roles: { doer: 'agt_worker0001', verifier: 'agt_verifier0001', approver: 'own_local' },
  };

  test('FW-C-040: a brief goes in word for word (voice as style); no brief changes nothing', () => {
    const brief = {
      what: 'A spring push',
      who: 'Lapsed neighbors',
      voice: 'Warm, plain',
      never: 'No discounts',
      done: '40 sign-ups',
    };
    const plain = compileWorkOrder(input);
    expect(plain.constraints.style).toBeUndefined();
    const wo = compileWorkOrder({ ...input, brief });
    expect(validate('work-order', wo).errors).toEqual([]);
    expect(wo.constraints.style).toEqual(["Voice, from the Owner's project brief: Warm, plain"]);
    const notes = wo.constraints.notes!.join('\n');
    for (const a of [brief.what, brief.who, brief.never, brief.done]) expect(notes).toContain(a);
    expect(wo.content_hash).not.toBe(plain.content_hash);
  });

  test('is deterministic for the same inputs', () => {
    expect(JSON.stringify(compileWorkOrder(input))).toBe(JSON.stringify(compileWorkOrder({ ...input })));
  });

  test('a row without files_hint compiles with a restrictive default scope', () => {
    const wo = compileWorkOrder(input);
    expect(wo.scope.touches).toEqual(['docs/notes/FW-C-942/**']);
    expect(wo.acceptance).toEqual([
      expect.objectContaining({ claim: probe.measures, probe_command: 'pnpm probe kernel/x' }),
    ]);
    expect(wo.budget).toEqual({
      caps: { max_usd: 4, max_minutes: 60, max_turns: 100, max_tokens: 2500000 },
      ttl_hours: 48,
    });
    expect(wo.expires_at).toBe('2026-11-11T10:00:00.000Z');
    expect(validate('work-order', wo).errors).toEqual([]);
  });
});
