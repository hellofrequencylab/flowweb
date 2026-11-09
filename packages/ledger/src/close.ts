// fw ledger close (WS-P0-021, Core adaptation: how the human-merge path finishes a row).
// The row's probe runs against the merged artifact: the checkout at repoDir must have HEAD equal to
// merged_sha and no tracked changes. The run is recorded first (ledger.probe_executed). Then, in one
// transaction: on a pass, an immutable kernel-captured evidence bundle bound to merged_sha is written
// (evidence.bundle_created) and the row moves verifying -> done (ledger.row_status_changed). On a
// fail the same move is attempted without a bundle, so the done-requires-proof trigger refuses it and
// its message is surfaced. A refusal rolls the whole transaction back.
import type { EvidenceBundle } from '@fw/contracts';
import { validate } from '@fw/contracts';
import { canonicalJson, newId, nowIso, sha256Hex, type Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from './bootstrap.ts';
import { LedgerError, surfaceDbRefusal } from './errors.ts';
import { isLegalTransition, transitionRow } from './fsm.ts';
import { gitHead, gitTrackedClean } from './git.ts';
import { codeFromRowId } from './ids.ts';
import { executeCommandProbe, recordProbeResult, runnableProbe } from './probe.ts';
import { getDbRow } from './rows.ts';

export interface CloseOptions {
  mergedSha: string;
  repoDir: string;
  actor?: Actor;
  now?: () => Date;
  timeoutMs?: number;
}

/** The probe section an evidence bundle is bound to (by intent_payload.payload_hash). */
export interface ProbeEvidence {
  exit_code: number | null;
  output_tail: string;
  duration_ms: number;
}

export interface CloseReport {
  code: string;
  status: 'done';
  merged_sha: string;
  bundle_id: string;
  bundle_hash: string;
  result_id: string;
  probe: ProbeEvidence;
}

/** sha256 of the canonical bundle without bundle_hash. */
export function bundleHash(bundle: Omit<EvidenceBundle, 'bundle_hash'> | EvidenceBundle): string {
  const { bundle_hash: _ignored, ...rest } = bundle as EvidenceBundle;
  return sha256Hex(canonicalJson(rest));
}

export function closeEvidenceBundle(args: {
  id: string;
  code: string;
  mergedSha: string;
  probe: ProbeEvidence;
  argv: string[];
  probeEventId: string;
  resultId: string;
  at: string;
}): EvidenceBundle {
  const summary = `exit ${args.probe.exit_code} in ${args.probe.duration_ms} ms: ${args.argv.join(' ')}`;
  const body: Omit<EvidenceBundle, 'bundle_hash'> = {
    id: args.id,
    subject: { kind: 'pull_request', ref: `commit:${args.mergedSha}`, sha: args.mergedSha },
    intent_payload: {
      rendered_ref: `event:${args.probeEventId}`,
      payload_hash: sha256Hex(canonicalJson(args.probe)),
      format: 'json',
    },
    provenance: {
      untrusted_inputs: [],
      rule_of_two: {
        untrusted_input: false,
        sensitive_access: false,
        state_change_or_external_comms: false,
        score: 0,
      },
    },
    automated_evidence: [
      {
        name: `row probe on the merged artifact (${args.code})`,
        kind: 'probe',
        status: 'pass',
        artifact_ref: `result:${args.resultId}`,
        ran_at: args.at,
        summary: summary.length > 300 ? `${summary.slice(0, 297)}...` : summary,
      },
    ],
    blast_radius: {
      summary: 'Closing evidence for a merged commit; records a probe result and changes no code.',
      reversible: true,
      rollback_plan: 'Revert the merged commit; the row regresses on its next failing probe run.',
      rollback_tested: false,
    },
    scan_red: false,
    captured_by: 'kernel',
    created_at: args.at,
    not_verified: ['Scans, diff policy and verifier review are not part of a C0 close bundle.'],
  };
  return { ...body, bundle_hash: bundleHash(body) };
}

export async function closeRow(w: Writer, code: string, opts: CloseOptions): Promise<CloseReport> {
  const now = opts.now ?? (() => new Date());
  const mergedSha = opts.mergedSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(mergedSha))
    throw new LedgerError(
      'BAD_ARGUMENT',
      `--merged-sha must be a full 40-character commit sha: ${opts.mergedSha}`,
    );
  const row = getDbRow(w, code);
  const rowCode = codeFromRowId(row.id);
  if (!isLegalTransition(row.status, 'done'))
    throw new LedgerError(
      'ILLEGAL_TRANSITION',
      `illegal ledger_row transition: ${rowCode} ${row.status} -> done (close needs a row in verifying)`,
      { code: rowCode, from: row.status, to: 'done' },
    );
  const head = gitHead(opts.repoDir);
  if (!head) throw new LedgerError('NOT_A_GIT_REPO', `${opts.repoDir} is not a git checkout`);
  if (head !== mergedSha)
    throw new LedgerError(
      'MERGED_SHA_MISMATCH',
      `the checkout at ${opts.repoDir} is at ${head}, not the merged commit ${mergedSha}; check out the merged commit first`,
      { head, merged_sha: mergedSha },
    );
  if (!gitTrackedClean(opts.repoDir))
    throw new LedgerError(
      'DIRTY_WORKTREE',
      `the checkout at ${opts.repoDir} has uncommitted changes to tracked files; the probe must run on the merged artifact as merged`,
    );

  const actor = opts.actor ?? ownerActor(w);
  const probe = runnableProbe(w, row, opts.repoDir, actor);
  const result = await executeCommandProbe(probe, {
    cwd: opts.repoDir,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const rec = recordProbeResult(
    w,
    getDbRow(w, row.id),
    result,
    { kind: 'merged', sha: mergedSha },
    actor,
    now,
  );
  const evidence: ProbeEvidence = {
    exit_code: result.exit_code,
    output_tail: result.output_tail,
    duration_ms: result.duration_ms,
  };

  return w.transaction((tx) => {
    const at = nowIso(now());
    if (result.status !== 'pass') {
      // No bundle: the done-requires-proof trigger refuses this, and its message is what the caller sees.
      transitionRow(tx, row.id, 'done', {
        actor,
        guard_evidence: { result_id: rec.result_id, merged_sha: mergedSha },
        set: { merged_sha: mergedSha, closed_at: at },
      });
      throw new LedgerError('REFUSED_BY_DATABASE', 'the database accepted done without a passing probe');
    }
    const bundle = closeEvidenceBundle({
      id: newId('evb'),
      code: rowCode,
      mergedSha,
      probe: evidence,
      argv: probe.command?.argv ?? [],
      probeEventId: rec.event_id,
      resultId: rec.result_id,
      at,
    });
    const check = validate('evidence-bundle', bundle);
    if (!check.ok)
      throw new Error(`close bundle is not a valid evidence bundle: ${JSON.stringify(check.errors)}`);
    surfaceDbRefusal(() =>
      tx.run(
        `INSERT INTO evidence_bundles(id, subject_kind, subject_ref, subject_sha, body, bundle_hash, scan_red, captured_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'kernel', ?)`,
        [
          bundle.id,
          bundle.subject.kind,
          bundle.subject.ref,
          mergedSha,
          canonicalJson(bundle),
          bundle.bundle_hash,
          at,
        ],
      ),
    );
    tx.appendEvent({
      type: 'evidence.bundle_created',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: row.project_id,
      stream_id: row.stream_id,
      idempotency_key: bundle.id,
      payload: {
        bundle_id: bundle.id,
        subject_kind: bundle.subject.kind,
        subject_ref: bundle.subject.ref,
        subject_sha: mergedSha,
        bundle_hash: bundle.bundle_hash,
        scan_red: false,
        ledger_row_id: row.id,
      },
    });
    transitionRow(tx, row.id, 'done', {
      actor,
      guard_evidence: { result_id: rec.result_id, merged_sha: mergedSha, evidence_bundle_id: bundle.id },
      set: { merged_sha: mergedSha, evidence_bundle_id: bundle.id, closed_at: at },
    });
    return {
      code: rowCode,
      status: 'done',
      merged_sha: mergedSha,
      bundle_id: bundle.id,
      bundle_hash: bundle.bundle_hash,
      result_id: rec.result_id,
      probe: evidence,
    };
  });
}
