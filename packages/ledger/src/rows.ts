// The ledger_rows table as stored, and its read-side shapes: a compact view (with the derived
// `code`) and the ledger-row contract object.
import type { LedgerRow, Probe } from '@fw/contracts';
import type { Reader } from '@fw/eventlog';
import { LedgerError } from './errors.ts';
import { codeFromRowId, resolveRowId } from './ids.ts';

export type RowStatus = LedgerRow['status'];

export interface DbRow {
  id: string;
  project_id: string;
  stream_id: string | null;
  title: string;
  priority: LedgerRow['priority'];
  lane: string;
  size: LedgerRow['size'];
  status: RowStatus;
  owner_kind: 'agent' | 'owner';
  owner_id: string;
  links: string;
  depends_on: string;
  wave: string | null;
  probe_revision: number;
  probe_kind: Probe['kind'];
  probe_spec: string;
  probe_expected: string;
  probe_measures: string;
  probe_runs_against: Probe['runs_against'];
  probe_hash: string;
  probe_trust_tier: number;
  premise_retested_at: string | null;
  premise_valid: 0 | 1 | null;
  merged_sha: string | null;
  last_probe_status: 'never' | 'pass' | 'fail' | 'error';
  last_probe_at: string | null;
  evidence_bundle_id: string | null;
  watch_hours: number;
  watch_until: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** What list, show and next print for a row. `code` is derived from the id. */
export interface RowView {
  code: string;
  id: string;
  project_id: string;
  stream_id: string | null;
  title: string;
  status: RowStatus;
  priority: LedgerRow['priority'];
  size: LedgerRow['size'];
  lane: string;
  wave: string | null;
  owner: { kind: 'agent' | 'owner'; id: string };
  depends_on: string[];
  premise_valid: boolean | null;
  premise_retested_at: string | null;
  last_probe_status: DbRow['last_probe_status'];
  last_probe_at: string | null;
  merged_sha: string | null;
  evidence_bundle_id: string | null;
  probe_hash: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export function getDbRow(r: Reader, codeOrId: string): DbRow {
  const id = resolveRowId(codeOrId);
  const row = r.get<DbRow>('SELECT * FROM ledger_rows WHERE id = ?', [id]);
  if (!row)
    throw new LedgerError('NOT_FOUND', `no ledger row ${codeFromRowId(id)} (run fw ledger sync first)`, {
      id,
    });
  return row;
}

export function toView(row: DbRow): RowView {
  return {
    code: codeFromRowId(row.id),
    id: row.id,
    project_id: row.project_id,
    stream_id: row.stream_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    size: row.size,
    lane: row.lane,
    wave: row.wave,
    owner: { kind: row.owner_kind, id: row.owner_id },
    depends_on: (JSON.parse(row.depends_on) as string[]).map(codeFromRowId),
    premise_valid: row.premise_valid === null ? null : row.premise_valid === 1,
    premise_retested_at: row.premise_retested_at,
    last_probe_status: row.last_probe_status,
    last_probe_at: row.last_probe_at,
    merged_sha: row.merged_sha,
    evidence_bundle_id: row.evidence_bundle_id,
    probe_hash: row.probe_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };
}

/** The stored probe as a contract object (definition from probe_spec plus content_hash = probe_hash). */
export function storedProbe(row: DbRow): Probe {
  return { ...(JSON.parse(row.probe_spec) as Omit<Probe, 'content_hash'>), content_hash: row.probe_hash };
}

/** The row as a ledger-row contract object. */
export function toContract(row: DbRow): LedgerRow {
  const out: LedgerRow = {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    priority: row.priority,
    lane: row.lane,
    size: row.size,
    status: row.status,
    owner: { kind: row.owner_kind, id: row.owner_id },
    links: JSON.parse(row.links) as string[],
    depends_on: JSON.parse(row.depends_on) as string[],
    probe: storedProbe(row),
    last_probe: { status: row.last_probe_status },
    watch_hours: row.watch_hours,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.stream_id) out.stream_id = row.stream_id;
  if (row.wave) out.wave = row.wave;
  if (row.last_probe_at && out.last_probe) out.last_probe.at = row.last_probe_at;
  if (row.premise_retested_at && row.premise_valid !== null)
    out.premise = { retested_at: row.premise_retested_at, still_valid: row.premise_valid === 1 };
  if (row.merged_sha) out.merged_sha = row.merged_sha;
  if (row.evidence_bundle_id) out.evidence_bundle_id = row.evidence_bundle_id;
  return out;
}
