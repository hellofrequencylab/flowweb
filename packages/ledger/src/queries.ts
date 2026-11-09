// Read-side queries behind fw ledger list, show and next. Readers only; nothing here writes.
import type { EvidenceBundle, LedgerRow, Probe } from '@fw/contracts';
import { canonicalJson, type Reader, sha256Hex } from '@fw/eventlog';
import type { ProbeEvidence } from './close.ts';
import { LedgerError } from './errors.ts';
import { ROW_STATUSES } from './fsm.ts';
import {
  type DbRow,
  getDbRow,
  type RowStatus,
  type RowView,
  storedProbe,
  toContract,
  toView,
} from './rows.ts';

const ORDER = "ORDER BY priority, COALESCE(wave, 'ZZ'), id";

export interface ListFilter {
  status?: string;
  lane?: string;
}

export function listRows(r: Reader, filter: ListFilter = {}): RowView[] {
  if (filter.status !== undefined && !ROW_STATUSES.includes(filter.status as RowStatus))
    throw new LedgerError(
      'BAD_ARGUMENT',
      `unknown status ${filter.status} (one of ${ROW_STATUSES.join(', ')})`,
    );
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.lane !== undefined) {
    where.push('lane = ?');
    params.push(filter.lane);
  }
  const sql = `SELECT * FROM ledger_rows ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER}`;
  return r.all<DbRow>(sql, params).map(toView);
}

/** The next workable row: ready, every dependency done, highest priority first. Null when none. */
export function nextRow(r: Reader): RowView | null {
  const row = r.get<DbRow>(
    `SELECT * FROM ledger_rows l WHERE status = 'ready'
       AND NOT EXISTS (SELECT 1 FROM json_each(l.depends_on) d JOIN ledger_rows x ON x.id = d.value WHERE x.status <> 'done')
       AND NOT EXISTS (SELECT 1 FROM json_each(l.depends_on) d WHERE d.value NOT IN (SELECT id FROM ledger_rows))
     ${ORDER} LIMIT 1`,
  );
  return row ? toView(row) : null;
}

/** Open rows whose dependencies are all done: candidates for a premise re-test. */
export function retestCandidates(r: Reader): number {
  return (
    r.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ledger_rows l WHERE status = 'open'
         AND NOT EXISTS (SELECT 1 FROM json_each(l.depends_on) d LEFT JOIN ledger_rows x ON x.id = d.value
                         WHERE x.status IS NOT 'done')`,
    )?.n ?? 0
  );
}

export interface EvidenceView {
  id: string;
  subject_sha: string | null;
  bundle_hash: string;
  scan_red: boolean;
  captured_by: string;
  created_at: string;
  bundle: EvidenceBundle;
  /** The probe run the bundle is bound to, when its payload hash matches. */
  probe: ProbeEvidence | null;
}

export interface RowDetail {
  row: RowView;
  contract: LedgerRow;
  probe: Probe;
  evidence: EvidenceView[];
  work_orders: {
    id: string;
    version: number;
    status: string;
    doer_agent_id: string | null;
    verifier_agent_id: string | null;
    issued_at: string | null;
    expires_at: string | null;
    content_hash: string;
  }[];
  events: { seq: number; ts: string; type: string; payload: Record<string, unknown> }[];
}

function evidenceProbe(r: Reader, bundle: EvidenceBundle): ProbeEvidence | null {
  const ref = bundle.intent_payload.rendered_ref;
  if (!ref.startsWith('event:')) return null;
  const ev = r.get<{ payload: string }>(
    "SELECT payload FROM events WHERE id = ? AND type = 'ledger.probe_executed'",
    [ref.slice(6)],
  );
  if (!ev) return null;
  const p = JSON.parse(ev.payload) as Record<string, unknown>;
  const probe = {
    exit_code: p.exit_code as number | null,
    output_tail: p.output_tail as string,
    duration_ms: p.duration_ms as number,
  };
  return sha256Hex(canonicalJson(probe)) === bundle.intent_payload.payload_hash ? probe : null;
}

export function showRow(r: Reader, code: string, eventLimit = 20): RowDetail {
  const row = getDbRow(r, code);
  const evidence = r
    .all<{
      id: string;
      subject_sha: string | null;
      bundle_hash: string;
      scan_red: number;
      captured_by: string;
      created_at: string;
      body: string;
    }>(
      `SELECT e.id, e.subject_sha, e.bundle_hash, e.scan_red, e.captured_by, e.created_at, e.body FROM evidence_bundles e
       WHERE e.id = ? OR e.id IN (SELECT json_extract(payload, '$.bundle_id') FROM events
                                  WHERE type = 'evidence.bundle_created' AND json_extract(payload, '$.ledger_row_id') = ?)
       ORDER BY e.created_at`,
      [row.evidence_bundle_id, row.id],
    )
    .map((e) => {
      const bundle = JSON.parse(e.body) as EvidenceBundle;
      return {
        id: e.id,
        subject_sha: e.subject_sha,
        bundle_hash: e.bundle_hash,
        scan_red: e.scan_red === 1,
        captured_by: e.captured_by,
        created_at: e.created_at,
        bundle,
        probe: evidenceProbe(r, bundle),
      };
    });
  const work_orders = r.all<RowDetail['work_orders'][number]>(
    `SELECT id, version, status, doer_agent_id, verifier_agent_id, issued_at, expires_at, content_hash
     FROM work_orders WHERE ledger_row_id = ? ORDER BY version`,
    [row.id],
  );
  const events = r
    .all<{ seq: number; ts: string; type: string; payload: string }>(
      `SELECT seq, ts, type, payload FROM events WHERE json_extract(payload, '$.ledger_row_id') = ?
       ORDER BY seq DESC LIMIT ?`,
      [row.id, eventLimit],
    )
    .reverse()
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) as Record<string, unknown> }));
  return {
    row: toView(row),
    contract: toContract(row),
    probe: storedProbe(row),
    evidence,
    work_orders,
    events,
  };
}
