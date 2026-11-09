// fw wo issue: compile a work order for a ready row and issue it.
// Refuses (before writing) an unready row, a size the policy cannot dispatch (XL), self-verification,
// a doer that is not an active worker, a verifier that is not an active verifier, and a row that
// already has a live order. The draft insert, work_order.drafted, the draft -> issued update (guarded
// by trg_wo_issue_gate) and work_order.issued all happen in one transaction.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkOrder } from '@fw/contracts';
import { canonicalJson, newId, type Writer } from '@fw/eventlog';
import { type Actor, BACKLOG_STREAM_KEY, DEFAULT_AGENTS, ownerActor, ownerId } from '../bootstrap.ts';
import { parseRowDefinition, probeFromDefinition, probeHash } from '../definition.ts';
import { LedgerError, surfaceDbRefusal } from '../errors.ts';
import { gitHead } from '../git.ts';
import { codeFromRowId } from '../ids.ts';
import { loadCorePolicy } from '../policy.ts';
import { checkedProbe } from '../probe.ts';
import { type DbRow, getDbRow } from '../rows.ts';
import { assertNotSelfVerify, compileWorkOrder, dispatchRule } from './compile.ts';

export interface IssueOptions {
  repoDir: string;
  /** FW_HOME, for the installed policy copy. */
  home?: string;
  /** Row definition files; default <repoDir>/ledger/rows. */
  rowsDir?: string;
  doer?: string;
  verifier?: string;
  actor?: Actor;
  now?: () => Date;
}

export interface IssueReport {
  code: string;
  work_order_id: string;
  version: number;
  content_hash: string;
  doer: string;
  verifier: string;
  expires_at: string;
  work_order: WorkOrder;
}

function checkAgent(w: Writer, id: string, role: 'worker' | 'verifier', what: string): void {
  const a = w.get<{ role: string; status: string }>('SELECT role, status FROM agents WHERE id = ?', [id]);
  if (!a) throw new LedgerError('AGENT_INVALID', `${what} ${id} is not a registered agent`);
  if (a.role !== role)
    throw new LedgerError('AGENT_INVALID', `${what} ${id} has role ${a.role}; it must be ${role}`);
  if (a.status !== 'active')
    throw new LedgerError('AGENT_INVALID', `${what} ${id} is ${a.status}, not active`);
}

/** files_hint and acceptance from the row file, only when its probe matches the one the ledger holds. */
function definitionExtras(row: DbRow, rowsDir: string): { files_hint?: string[]; acceptance?: string[] } {
  const code = codeFromRowId(row.id);
  const path = join(rowsDir, `${code}.json`);
  if (!existsSync(path)) return {};
  const check = parseRowDefinition(JSON.parse(readFileSync(path, 'utf8')), `${code}.json`);
  if (!check.ok) throw new LedgerError('INVALID_DEFINITION', `${path}: ${check.errors.join('; ')}`);
  const hash = probeHash(probeFromDefinition(check.def));
  if (hash !== row.probe_hash)
    throw new LedgerError(
      'PROBE_CHANGED',
      `${path} carries a different probe than the ledger holds for ${code}`,
      {
        stored_hash: row.probe_hash,
        file_hash: hash,
      },
    );
  return { files_hint: check.def.files_hint, acceptance: check.def.acceptance };
}

export function issueWorkOrder(w: Writer, code: string, opts: IssueOptions): IssueReport {
  const now = opts.now ?? (() => new Date());
  const row = getDbRow(w, code);
  const rowCode = codeFromRowId(row.id);
  const doer = opts.doer ?? DEFAULT_AGENTS.worker.id;
  const verifier = opts.verifier ?? DEFAULT_AGENTS.verifier.id;
  assertNotSelfVerify(rowCode, doer, verifier);
  const policy = loadCorePolicy(opts.repoDir, opts.home);
  dispatchRule(policy, rowCode, row.size);
  if (row.status !== 'ready' && row.status !== 'claimed')
    throw new LedgerError(
      'ROW_NOT_READY',
      `${rowCode} is ${row.status}; a work order needs a ready row (re-test its premise first: fw ledger retest ${rowCode})`,
      { code: rowCode, status: row.status },
    );
  checkAgent(w, doer, 'worker', 'doer');
  checkAgent(w, verifier, 'verifier', 'verifier');
  const live = w.get<{ id: string; status: string }>(
    "SELECT id, status FROM work_orders WHERE ledger_row_id = ? AND status IN ('draft','issued','running')",
    [row.id],
  );
  if (live)
    throw new LedgerError('ALREADY_ISSUED', `${rowCode} already has work order ${live.id} (${live.status})`, {
      work_order_id: live.id,
    });
  const baseCommit = gitHead(opts.repoDir);
  if (!baseCommit)
    throw new LedgerError(
      'NOT_A_GIT_REPO',
      `${opts.repoDir} is not a git checkout (a work order needs a base commit)`,
    );
  const streamId =
    row.stream_id ??
    w.get<{ id: string }>('SELECT id FROM streams WHERE project_id = ? AND key = ?', [
      row.project_id,
      BACKLOG_STREAM_KEY,
    ])?.id;
  if (!streamId)
    throw new LedgerError('NOT_FOUND', `${rowCode} has no stream and the project has no backlog stream`);
  const actor = opts.actor ?? ownerActor(w);
  const probe = checkedProbe(w, row, actor);
  const extras = definitionExtras(row, opts.rowsDir ?? join(opts.repoDir, 'ledger', 'rows'));
  const version =
    (w.get<{ v: number | null }>('SELECT MAX(version) AS v FROM work_orders WHERE ledger_row_id = ?', [
      row.id,
    ])?.v ?? 0) + 1;
  const wo = compileWorkOrder({
    id: newId('wo'),
    version,
    issuedAt: now(),
    row: {
      id: row.id,
      code: rowCode,
      title: row.title,
      size: row.size,
      project_id: row.project_id,
      stream_id: streamId,
    },
    probe,
    ...extras,
    baseCommit,
    policy,
    roles: { doer, verifier, approver: ownerId(w) },
  });

  return w.transaction((tx) => {
    const ev = {
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: row.project_id,
      stream_id: streamId,
      work_order_id: wo.id,
    };
    surfaceDbRefusal(() =>
      tx.run(
        `INSERT INTO work_orders(id, project_id, stream_id, ledger_row_id, version, title, base_commit, body, content_hash,
           autonomy_tier, doer_agent_id, verifier_agent_id, status, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [
          wo.id,
          row.project_id,
          streamId,
          row.id,
          version,
          wo.title,
          baseCommit,
          canonicalJson(wo),
          wo.content_hash,
          wo.autonomy_tier,
          doer,
          verifier,
          wo.issued_at,
          wo.expires_at,
        ],
      ),
    );
    tx.appendEvent({
      ...ev,
      type: 'work_order.drafted',
      idempotency_key: `${wo.id}+${version}`,
      payload: { work_order_id: wo.id, ledger_row_id: row.id, version, content_hash: wo.content_hash },
    });
    surfaceDbRefusal(() => tx.run("UPDATE work_orders SET status = 'issued' WHERE id = ?", [wo.id]), {
      work_order_id: wo.id,
    });
    tx.appendEvent({
      ...ev,
      type: 'work_order.issued',
      idempotency_key: `${wo.id}+${wo.content_hash}`,
      payload: {
        work_order_id: wo.id,
        content_hash: wo.content_hash,
        doer_agent_id: doer,
        verifier_agent_id: verifier,
        autonomy_tier: wo.autonomy_tier,
        expires_at: wo.expires_at,
      },
    });
    return {
      code: rowCode,
      work_order_id: wo.id,
      version,
      content_hash: wo.content_hash!,
      doer,
      verifier,
      expires_at: wo.expires_at!,
      work_order: wo,
    };
  });
}
