// fw ledger sync: row definition files -> ledger_rows.
//
// All or nothing. Every file is read, checked and hashed, and the dependency graph is checked,
// before anything is written. If any row is refused (invalid file, a probe that differs from the one
// the database holds, an unknown dependency, a cycle), the sync writes nothing at all, not even the
// bootstrap rows, and reports every refusal. Otherwise one transaction creates what is missing, each
// new row as `open` with a ledger.row_created event. A second run with the same files writes nothing.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@fw/contracts';
import { canonicalJson, nowIso, type Writer } from '@fw/eventlog';
import { type Actor, ensureBootstrap, findBootstrap, ownerActor, type ProjectConfig } from './bootstrap.ts';
import {
  contractProbe,
  type ProbeDefinition,
  parseRowDefinition,
  probeFromDefinition,
  probeHash,
  type RowDefinition,
  rowOwner,
} from './definition.ts';
import { analyzeGraph, type GraphReport } from './graph.ts';
import { codeFromRowId, rowIdFromCode } from './ids.ts';

export type RefusalReason = 'invalid' | 'duplicate' | 'probe_changed' | 'unknown_dependency' | 'cycle';

export interface SyncRefusal {
  code: string;
  reason: RefusalReason;
  message: string;
  file?: string;
  id?: string;
  stored_hash?: string;
  file_hash?: string;
  cycle?: string[];
}

export interface SyncReport {
  /** True when the transaction ran (nothing was refused). */
  applied: boolean;
  created: string[];
  unchanged: string[];
  refused: SyncRefusal[];
  /** Synced rows whose non-probe fields differ from the database. Reported only; sync never edits a row. */
  drifted: { code: string; fields: string[] }[];
  graph: Omit<GraphReport, 'unknown'>;
  project_id: string | null;
}

export interface SyncOptions {
  rowsDir: string;
  project: ProjectConfig;
  actor?: Actor;
  now?: () => Date;
}

interface Loaded {
  def: RowDefinition;
  file: string;
  probe: ProbeDefinition;
  hash: string;
}

interface StoredRow {
  id: string;
  probe_hash: string;
  depends_on: string;
  title: string;
  priority: string;
  lane: string;
  size: string;
  wave: string | null;
}

function readDefinitions(rowsDir: string): { loaded: Loaded[]; refused: SyncRefusal[] } {
  const loaded: Loaded[] = [];
  const refused: SyncRefusal[] = [];
  const seen = new Map<string, string>();
  const files = readdirSync(rowsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    const path = join(rowsDir, file);
    const code = file.replace(/\.json$/, '');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      refused.push({
        code,
        file: path,
        reason: 'invalid',
        message: `not valid JSON: ${(e as Error).message}`,
      });
      continue;
    }
    const check = parseRowDefinition(raw, file);
    if (!check.ok) {
      refused.push({ code, file: path, reason: 'invalid', message: check.errors.join('; ') });
      continue;
    }
    const prior = seen.get(check.def.id);
    if (prior) {
      refused.push({ code, file: path, reason: 'duplicate', message: `same id as ${prior}` });
      continue;
    }
    seen.set(check.def.id, path);
    const probe = probeFromDefinition(check.def);
    loaded.push({ def: check.def, file: path, probe, hash: probeHash(probe) });
  }
  return { loaded, refused };
}

/** The ledger-row contract object a definition becomes (status open). Used to validate before insert. */
export function rowContract(
  def: RowDefinition,
  probe: ProbeDefinition,
  ids: { projectId: string; streamId: string; ownerId: string; leadAgentId: string },
  createdAt: string,
) {
  return {
    id: rowIdFromCode(def.id),
    project_id: ids.projectId,
    stream_id: ids.streamId,
    title: def.title,
    priority: def.priority,
    lane: def.lane,
    size: def.size,
    status: 'open' as const,
    owner: rowOwner(def, ids.ownerId, ids.leadAgentId),
    links: [],
    depends_on: def.depends_on.map(rowIdFromCode),
    ...(def.core_milestone ? { wave: def.core_milestone } : {}),
    probe: contractProbe(probe),
    last_probe: { status: 'never' as const },
    watch_hours: 24,
    created_at: createdAt,
  };
}

function driftOf(def: RowDefinition, stored: StoredRow): string[] {
  const fields: string[] = [];
  if (def.title !== stored.title) fields.push('title');
  if (def.priority !== stored.priority) fields.push('priority');
  if (def.lane !== stored.lane) fields.push('lane');
  if (def.size !== stored.size) fields.push('size');
  if ((def.core_milestone ?? null) !== stored.wave) fields.push('wave');
  if (canonicalJson(def.depends_on.map(rowIdFromCode)) !== canonicalJson(JSON.parse(stored.depends_on)))
    fields.push('depends_on');
  return fields;
}

/** Syncs every <CODE>.json in rowsDir into the ledger. See the file header for the rules. */
export function syncRows(w: Writer, opts: SyncOptions): SyncReport {
  const now = opts.now ?? (() => new Date());
  const { loaded, refused } = readDefinitions(opts.rowsDir);

  const stored = new Map<string, StoredRow>();
  for (const r of w.all<StoredRow>(
    'SELECT id, probe_hash, depends_on, title, priority, lane, size, wave FROM ledger_rows',
  ))
    stored.set(codeFromRowId(r.id), r);

  const created: Loaded[] = [];
  const unchanged: string[] = [];
  const drifted: { code: string; fields: string[] }[] = [];
  for (const l of loaded) {
    const s = stored.get(l.def.id);
    if (!s) {
      created.push(l);
      continue;
    }
    if (s.probe_hash !== l.hash) {
      refused.push({
        code: l.def.id,
        file: l.file,
        id: s.id,
        reason: 'probe_changed',
        stored_hash: s.probe_hash,
        file_hash: l.hash,
        message:
          'the probe in the row file differs from the probe the ledger holds; probes are immutable (park the row and add a superseding row)',
      });
      continue;
    }
    unchanged.push(l.def.id);
    const fields = driftOf(l.def, s);
    if (fields.length) drifted.push({ code: l.def.id, fields });
  }

  // Graph over the database rows plus the files (the file wins for a row present in both).
  const deps = new Map<string, readonly string[]>();
  for (const [code, s] of stored) deps.set(code, (JSON.parse(s.depends_on) as string[]).map(codeFromRowId));
  for (const l of loaded) deps.set(l.def.id, l.def.depends_on);
  const graph = analyzeGraph(deps);
  for (const u of graph.unknown)
    refused.push({
      code: u.code,
      reason: 'unknown_dependency',
      message: `depends on ${u.missing}, which is neither in the ledger nor in the row files`,
    });
  for (const cycle of graph.cycles)
    refused.push({
      code: cycle[0]!,
      reason: 'cycle',
      cycle,
      message: `dependency cycle: ${cycle.join(' -> ')}`,
    });

  const { unknown: _u, ...graphReport } = graph;
  if (refused.length) {
    return {
      applied: false,
      created: [],
      unchanged,
      refused,
      drifted,
      graph: graphReport,
      project_id: findBootstrap(w, opts.project.slug).projectId ?? null,
    };
  }

  const projectId = w.transaction((tx) => {
    const actor = opts.actor ?? ownerActor(tx);
    const boot = ensureBootstrap(tx, opts.project, actor, now);
    for (const l of created) {
      const createdAt = nowIso(now());
      const row = rowContract(l.def, l.probe, boot, createdAt);
      const check = validate('ledger-row', row);
      if (!check.ok)
        throw new Error(
          `row ${l.def.id} does not map to a valid ledger row: ${JSON.stringify(check.errors)}`,
        );
      tx.run(
        `INSERT INTO ledger_rows(id, project_id, stream_id, title, priority, lane, size, status, owner_kind, owner_id,
           links, depends_on, wave, probe_revision, probe_kind, probe_spec, probe_expected, probe_measures,
           probe_runs_against, probe_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.project_id,
          row.stream_id,
          row.title,
          row.priority,
          row.lane,
          row.size,
          row.owner.kind,
          row.owner.id,
          canonicalJson(row.links),
          canonicalJson(row.depends_on),
          l.def.core_milestone ?? null,
          l.probe.version,
          l.probe.kind,
          canonicalJson(l.probe),
          canonicalJson(l.probe.expected),
          l.probe.measures,
          l.probe.runs_against,
          l.hash,
          createdAt,
          createdAt,
        ],
      );
      tx.appendEvent({
        type: 'ledger.row_created',
        actor_kind: actor.kind,
        actor_id: actor.id,
        project_id: boot.projectId,
        stream_id: boot.streamId,
        idempotency_key: row.id,
        payload: {
          ledger_row_id: row.id,
          code: l.def.id,
          project_id: boot.projectId,
          priority: row.priority,
          lane: row.lane,
          probe_hash: l.hash,
          created_by: actor.id,
        },
      });
    }
    return boot.projectId;
  });

  return {
    applied: true,
    created: created.map((l) => l.def.id),
    unchanged,
    refused: [],
    drifted,
    graph: graphReport,
    project_id: projectId,
  };
}
