// WS-P0-038: the evidence bundle builder. Pure: the same input gives the same bundle and hash. The
// body is exactly contracts-core/json-schema/evidence-bundle.json, so everything the API's `view`
// shows is encoded where that schema allows it:
//   - the diff: intent_payload {rendered_ref: the stored diff, payload_hash: sha256 of its bytes, format: diff}
//   - the probe, each check, each diff-policy rule, the cost: automated_evidence entries
//   - the sandbox level and controls, and the adapter fingerprint: automated_evidence entries of kind
//     'other' with fixed names and a `key=value` summary (provenance allows no extra fields)
// The API derives the view back from these entries (src/api/evidence-view.ts).
import type { EvidenceBundle } from '@fw/contracts';
import { validate } from '@fw/contracts';
import { canonicalJson, sha256Hex } from '@fw/eventlog';
import type { DiffRule, DiffVerdict } from '@fw/policy';

export const EVIDENCE_NAMES = {
  sandbox: 'sandbox self-test',
  adapter: 'adapter fingerprint',
  cost: 'cost record',
  policyPrefix: 'diff policy: ',
  checkPrefix: 'check: ',
} as const;

/** Every rule the diff policy can report, each recorded as pass or fail. */
export const POLICY_RULES: readonly DiffRule[] = [
  'tier0_path',
  'outside_allowed_files',
  'invalid_path',
  'unknown_status',
  'policy_error',
];

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface EvidenceInput {
  id: string;
  /** The run branch head the bundle is bound to; the PR is opened from it after the bundle exists. */
  subject: { kind: 'pull_request'; ref: string; sha: string };
  code: string;
  diff: {
    /** Where the bytes are stored (relative to FW_HOME). */
    ref: string;
    bytes: Buffer | string;
    files: DiffFileStat[];
  };
  probe: {
    argv: string[];
    status: 'pass' | 'fail' | 'error';
    exit_code: number | null;
    duration_ms: number;
    result_id: string;
    ran_at: string;
  };
  checks: {
    argv: string[];
    status: CheckStatus;
    exit_code: number | null;
    duration_ms: number;
    ran_at: string;
  }[];
  policy: { verdict: DiffVerdict; ran_at: string };
  sandbox: { level: string; mode: string; controls: Record<string, string>; checked_at: string };
  adapter: { name: string; vendor: string; version: string; help_sha256: string; checked_at: string };
  cost: {
    usd: number | null;
    tokens_in: number;
    tokens_out: number;
    tokens_cached: number;
    estimated: boolean;
  };
  provenance: EvidenceBundle['provenance'];
  now: string;
}

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
}

export interface BuiltEvidence {
  bundle: EvidenceBundle;
  bundle_hash: string;
  diff_hash: string;
  scan_red: boolean;
  failing: string[];
}

const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

/** sha256 of the canonical bundle without bundle_hash (the same rule as the closing bundle). */
export function evidenceBundleHash(bundle: Omit<EvidenceBundle, 'bundle_hash'> | EvidenceBundle): string {
  const { bundle_hash: _ignored, ...rest } = bundle as EvidenceBundle;
  return sha256Hex(canonicalJson(rest));
}

/** Per-file added and removed line counts of a git unified diff. Binary files count 0 and 0. */
export function diffFileStats(diff: string): DiffFileStat[] {
  const out: DiffFileStat[] = [];
  let cur: DiffFileStat | undefined;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!, added: 0, removed: 0 };
      out.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return out;
}

function kv(pairs: Record<string, string | number | boolean | null>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v === null ? 'unknown' : String(v)}`)
    .join(' ');
}

/** Parses a `key=value ...` summary written by kv(). */
export function parseKv(summary: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of (summary ?? '').split(/\s+/)) {
    const i = tok.indexOf('=');
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

export function buildEvidenceBundle(input: EvidenceInput): BuiltEvidence {
  const diffHash = sha256Hex(input.diff.bytes);
  const ev: EvidenceBundle['automated_evidence'] = [];
  const failing: string[] = [];

  const probeStatus = input.probe.status === 'pass' ? 'pass' : 'fail';
  if (probeStatus === 'fail') failing.push('row probe');
  ev.push({
    name: `row probe on the run branch (${input.code})`,
    kind: 'probe',
    status: probeStatus,
    artifact_ref: `result:${input.probe.result_id}`,
    ran_at: input.probe.ran_at,
    summary: clip(
      `exit ${input.probe.exit_code ?? 'none'} in ${input.probe.duration_ms} ms: ${input.probe.argv.join(' ')}`,
    ),
  });

  if (input.checks.length === 0) {
    ev.push({
      name: `${EVIDENCE_NAMES.checkPrefix}none`,
      kind: 'tests',
      status: 'skipped',
      ran_at: input.probe.ran_at,
      summary: 'the work order names no check command beyond the row probe',
    });
  }
  for (const c of input.checks) {
    if (c.status === 'fail') failing.push(`check ${c.argv.join(' ')}`);
    ev.push({
      name: clip(`${EVIDENCE_NAMES.checkPrefix}${c.argv.join(' ')}`, 200),
      kind: 'tests',
      status: c.status,
      ran_at: c.ran_at,
      summary: clip(`exit ${c.exit_code ?? 'none'} in ${c.duration_ms} ms`),
    });
  }

  const v = input.policy.verdict;
  for (const rule of POLICY_RULES) {
    const hits = v.violations.filter((x) => x.rule === rule);
    if (hits.length) failing.push(`diff policy ${rule}`);
    ev.push({
      name: `${EVIDENCE_NAMES.policyPrefix}${rule}`,
      kind: 'diff_policy',
      status: hits.length ? 'fail' : 'pass',
      artifact_ref: `diff-policy:${v.diff_hash || 'none'}`,
      ran_at: input.policy.ran_at,
      summary: clip(
        hits.length
          ? `${hits.length} violation(s): ${hits.map((h) => h.path).join(', ')}`
          : `no violation in ${v.checked} changed path(s)`,
      ),
    });
  }

  const sb = input.sandbox;
  ev.push({
    name: EVIDENCE_NAMES.sandbox,
    kind: 'other',
    status: sb.level === 'enforced' ? 'pass' : 'warn',
    ran_at: sb.checked_at,
    summary: clip(kv({ level: sb.level, mode: sb.mode, ...sb.controls })),
  });

  const ad = input.adapter;
  ev.push({
    name: EVIDENCE_NAMES.adapter,
    kind: 'other',
    status: 'pass',
    ran_at: ad.checked_at,
    summary: clip(kv({ name: ad.name, vendor: ad.vendor, version: ad.version, help_sha256: ad.help_sha256 })),
  });

  ev.push({
    name: EVIDENCE_NAMES.cost,
    kind: 'cost_estimate',
    status: input.cost.usd === null ? 'warn' : 'pass',
    ran_at: input.now,
    summary: clip(
      kv({
        usd: input.cost.usd,
        tokens_in: input.cost.tokens_in,
        tokens_out: input.cost.tokens_out,
        tokens_cached: input.cost.tokens_cached,
        estimated: input.cost.estimated,
      }),
    ),
  });

  const added = input.diff.files.reduce((n, f) => n + f.added, 0);
  const removed = input.diff.files.reduce((n, f) => n + f.removed, 0);
  const notVerified = [
    'No independent verifier review in C0; the Owner reviews the pull request.',
    'Scans other than the path diff policy (secrets, dependencies, deleted tests) did not run.',
  ];
  const weak = Object.entries(sb.controls)
    .filter(([, l]) => l !== 'enforced')
    .map(([k, l]) => `${k} ${l}`);
  if (weak.length) notVerified.push(clip(`Sandbox controls not enforced: ${weak.join(', ')}.`));
  if (input.checks.length === 0) notVerified.push('No check command ran (the work order names none).');
  if (input.cost.usd === null) notVerified.push('The vendor reported no cost; spend is unknown.');
  else if (input.cost.estimated)
    notVerified.push('Cost is estimated from token counts, not reported by the vendor.');

  const body: Omit<EvidenceBundle, 'bundle_hash'> = {
    id: input.id,
    subject: input.subject,
    intent_payload: { rendered_ref: input.diff.ref, payload_hash: diffHash, format: 'diff' },
    provenance: input.provenance,
    automated_evidence: ev,
    blast_radius: {
      summary: clip(
        `Pull request from ${input.subject.ref} changing ${input.diff.files.length} file(s) (+${added} -${removed}); nothing merges without the Owner.`,
        400,
      ),
      affected: input.diff.files.map((f) => f.path).slice(0, 200),
      reversible: true,
      rollback_plan: 'Close the pull request and delete the branch; nothing has merged.',
      rollback_tested: false,
    },
    ...(input.cost.usd !== null ? { cost_estimate_usd: input.cost.usd } : {}),
    scan_red: failing.length > 0,
    captured_by: 'kernel',
    created_at: input.now,
    not_verified: notVerified,
  };
  const bundle_hash = evidenceBundleHash(body);
  const bundle: EvidenceBundle = { ...body, bundle_hash };
  const check = validate('evidence-bundle', bundle);
  if (!check.ok)
    throw new Error(
      `evidence bundle is not valid against evidence-bundle.json: ${JSON.stringify(check.errors)}`,
    );
  return { bundle, bundle_hash, diff_hash: diffHash, scan_red: failing.length > 0, failing };
}

export interface CommentInput {
  bundle: EvidenceBundle;
  diff: { ref: string; files: DiffFileStat[] };
  run_id: string;
  probe: EvidenceInput['probe'];
  policy: DiffVerdict;
  checks: EvidenceInput['checks'];
  cost: EvidenceInput['cost'];
  sandbox: { level: string; mode: string };
  adapter: { name: string; version: string };
}

const fmtUsd = (usd: number | null) => (usd === null ? 'unknown' : `$${usd.toFixed(4)}`);

/** The PR comment: what the Owner needs at a glance, bound to the bundle by its hash. */
export function prComment(c: CommentInput): string {
  const b = c.bundle;
  const added = c.diff.files.reduce((n, f) => n + f.added, 0);
  const removed = c.diff.files.reduce((n, f) => n + f.removed, 0);
  const checks = c.checks.length
    ? c.checks.map((x) => `${x.status} (\`${x.argv.join(' ')}\`, exit ${x.exit_code ?? 'none'})`).join('; ')
    : 'skipped: the work order names no check command';
  const policy = c.policy.allowed
    ? `pass: no violation in ${c.policy.checked} changed path(s)`
    : `FAIL: ${c.policy.violations.map((v) => `${v.rule} ${v.path}`).join(', ')}`;
  const lines = [
    '### FlowWeb evidence',
    '',
    '| | |',
    '|---|---|',
    `| Evidence bundle | \`${b.id}\` |`,
    `| Bundle hash | \`${b.bundle_hash}\` |`,
    `| Run | \`${c.run_id}\` at \`${b.subject.sha ?? ''}\` |`,
    `| Diff | ${c.diff.files.length} file(s), +${added} -${removed}; sha256 \`${b.intent_payload.payload_hash}\` |`,
    `| Row probe | ${c.probe.status}: exit ${c.probe.exit_code ?? 'none'} in ${c.probe.duration_ms} ms (\`${c.probe.argv.join(' ')}\`) |`,
    `| Checks | ${checks} |`,
    `| Diff policy | ${policy} |`,
    `| Cost | ${fmtUsd(c.cost.usd)}${c.cost.estimated ? ' (estimated)' : ''}; ${c.cost.tokens_in} in, ${c.cost.tokens_out} out, ${c.cost.tokens_cached} cached tokens |`,
    `| Sandbox | ${c.sandbox.level} (${c.sandbox.mode}) |`,
    `| Adapter | ${c.adapter.name} ${c.adapter.version} |`,
    '',
    `Captured by the kernel, not the agent. Scan: ${b.scan_red ? 'RED' : 'green'}.`,
    ...(b.not_verified?.length ? ['', 'Not verified:', ...b.not_verified.map((n) => `- ${n}`)] : []),
  ];
  return lines.join('\n');
}
