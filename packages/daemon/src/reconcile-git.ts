// Git host reconciler (WS-P1-006): compares the pull requests on the git host with the ledger and
// repairs drift. fwd runs it every watchdog.reconciler_interval_minutes; it is also callable directly.
//   - A PR that maps to a row and was merged outside the tool: the merged sha is recorded on the row
//     (still verifying, the human-merge path) and its post-merge probe is queued; `fw ledger close` on
//     that commit runs it. merging/watching need a merge-slot grant, which an outside merge never has.
//   - An open PR that maps to no row: an Owner-owned orphan row (RC-O-nnn) is opened for it.
// A PR maps to a row by a run's pull_request artifact, else by a row code in its branch or title.
// Every repair emits reconciler.drift_detected in the same transaction; every pass ends with one
// reconciler.completed. A second pass over the same host state changes nothing.
import type { Writer } from '@fw/eventlog';
import { canonicalJson, nowIso } from '@fw/eventlog';
import { codeFromRowId, ownerId, type ProbeDefinition, probeHash, rowIdFromCode } from '@fw/ledger';
import type { GitHost, PrListing } from './edge-git/index.ts';

const ACTOR = { actor_kind: 'system', actor_id: 'fwd.reconciler' } as const;
const CODE_IN_TEXT = /\b([A-Z]{2}-[A-Z][0-9]?-[0-9]{3})\b/g;
/** Row states in which a merge made outside the tool can still be recorded. */
const AWAITING_MERGE = ['verifying', 'awaiting_approval'];

export interface DriftItem {
  kind: 'missed_webhook' | 'orphan_pr';
  external_ref: string;
  ledger_row_id: string | null;
}

export interface GitReconcileReport {
  checked: number;
  changes: number;
  drift: DriftItem[];
  duration_ms: number;
}

function rowForPr(w: Writer, pr: PrListing): string | undefined {
  const byArtifact = w.get<{ id: string }>(
    `SELECT o.ledger_row_id AS id FROM run_artifacts a JOIN runs r ON r.id = a.run_id
       JOIN work_orders o ON o.id = r.work_order_id
      WHERE a.kind = 'pull_request' AND a.ref = ? ORDER BY a.id DESC LIMIT 1`,
    [pr.url],
  );
  if (byArtifact) return byArtifact.id;
  for (const m of `${pr.head} ${pr.title}`.matchAll(CODE_IN_TEXT)) {
    const id = rowIdFromCode(m[1]!);
    if (w.get('SELECT 1 FROM ledger_rows WHERE id = ?', [id])) return id;
  }
  return w.get<{ id: string }>('SELECT id FROM ledger_rows WHERE links LIKE ? ESCAPE ?', [
    `%${JSON.stringify(pr.url)
      .slice(1, -1)
      .replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    '\\',
  ])?.id;
}

function nextOrphanCode(w: Writer): string {
  const last = w.get<{ id: string }>(
    "SELECT id FROM ledger_rows WHERE id LIKE 'lr_RCO%' ORDER BY id DESC LIMIT 1",
  );
  const n = last ? Number(last.id.slice(-3)) + 1 : 1;
  return `RC-O-${String(n).padStart(3, '0')}`;
}

function openOrphanRow(w: Writer, pr: PrListing, projectId: string): string {
  const owner = ownerId(w);
  const code = nextOrphanCode(w);
  const id = rowIdFromCode(code);
  const probe: ProbeDefinition = {
    id: `prb_${id.slice(3)}`,
    version: 1,
    kind: 'manual_attestation',
    measures: `The Owner has explained or closed pull request ${pr.url}, which no ledger row accounted for`,
    runs_against: 'external_state',
    expected: { attestation: 'explained or closed by the Owner' },
    owner_trust_tier: 0,
  } as ProbeDefinition;
  const hash = probeHash(probe);
  const at = nowIso();
  w.run(
    `INSERT INTO ledger_rows(id, project_id, title, priority, lane, size, status, owner_kind, owner_id, links,
       probe_kind, probe_spec, probe_expected, probe_measures, probe_runs_against, probe_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'P2', 'reconciler', 'S', 'open', 'owner', ?, ?, 'manual_attestation', ?, ?, ?, 'external_state', ?, ?, ?)`,
    [
      id,
      projectId,
      `Unexplained pull request #${pr.number}: ${pr.title}`.slice(0, 200),
      owner,
      canonicalJson([pr.url]),
      canonicalJson(probe),
      canonicalJson(probe.expected),
      probe.measures,
      hash,
      at,
      at,
    ],
  );
  w.appendEvent({
    ...ACTOR,
    type: 'ledger.row_created',
    project_id: projectId,
    idempotency_key: id,
    payload: {
      ledger_row_id: id,
      code,
      project_id: projectId,
      priority: 'P2',
      lane: 'reconciler',
      probe_hash: hash,
      created_by: ACTOR.actor_id,
    },
  });
  return id;
}

export async function reconcileGitHost(
  w: Writer,
  host: GitHost,
  opts: { project?: string } = {},
): Promise<GitReconcileReport> {
  const started = Date.now();
  const prs = await host.listPullRequests();
  const projects = w.all<{ id: string }>('SELECT id FROM projects ORDER BY created_at');
  const projectId = opts.project ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (!projectId) throw new Error('reconcileGitHost: name the project (this home has more than one)');
  const report: GitReconcileReport = { checked: prs.length, changes: 0, drift: [], duration_ms: 0 };

  w.transaction((tx) => {
    const drift = (
      kind: DriftItem['kind'],
      pr: PrListing,
      rowId: string,
      extra: Record<string, unknown> = {},
    ) => {
      tx.appendEvent({
        ...ACTOR,
        type: 'reconciler.drift_detected',
        project_id: projectId,
        idempotency_key: `${kind}+${pr.url}+${pr.merged_sha ?? pr.head_sha}`,
        payload: { kind, external_ref: pr.url, ledger_row_id: rowId, pr_state: pr.state, ...extra },
      });
      report.drift.push({ kind, external_ref: pr.url, ledger_row_id: rowId });
      report.changes++;
    };
    for (const pr of prs) {
      const rowId = rowForPr(tx, pr);
      if (rowId) {
        if (pr.state !== 'merged' || !pr.merged_sha) continue;
        const row = tx.get<{ status: string; merged_sha: string | null }>(
          'SELECT status, merged_sha FROM ledger_rows WHERE id = ?',
          [rowId],
        )!;
        if (!AWAITING_MERGE.includes(row.status) || row.merged_sha === pr.merged_sha) continue;
        tx.run('UPDATE ledger_rows SET merged_sha = ? WHERE id = ?', [pr.merged_sha, rowId]);
        drift('missed_webhook', pr, rowId, {
          merged_sha: pr.merged_sha,
          probe_queued: true,
          next: `fw ledger close ${codeFromRowId(rowId)} --merged-sha ${pr.merged_sha}`,
        });
      } else if (pr.state === 'open') {
        drift('orphan_pr', pr, openOrphanRow(tx, pr, projectId));
      }
    }
    report.duration_ms = Date.now() - started;
    tx.appendEvent({
      ...ACTOR,
      type: 'reconciler.completed',
      project_id: projectId,
      payload: {
        scope: 'git_host',
        items_checked: report.checked,
        drift_count: report.drift.length,
        duration_ms: report.duration_ms,
      },
    });
  });
  return report;
}
