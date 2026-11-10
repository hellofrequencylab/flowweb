// The `view` the API offers beside an evidence bundle: the same facts the PR comment shows, derived
// back from where the builder (src/pipeline/evidence.ts) encodes them inside the contract's shape.
// Bundles are immutable, so each part reads the current field first (diff, provenance.sandbox,
// provenance.adapter) and falls back to the older encoding (intent_payload with blast_radius.affected,
// the 'sandbox self-test' and 'adapter fingerprint' automated_evidence entries). A bundle that has
// neither (a closing bundle) gets null for that part.
import { EVIDENCE_NAMES, parseKv } from '../pipeline/evidence.ts';

type Row = Record<string, unknown>;
type DiffFile = { path: string; added: number; removed: number };

interface Entry {
  name: string;
  kind: string;
  status: string;
  artifact_ref?: string;
  ran_at?: string;
  summary?: string;
}

export interface EvidenceView {
  probe: { status: string; result_id: string | null; summary: string | null; ran_at: string | null } | null;
  /** added and removed are null for an older bundle, which recorded only the paths. */
  diff: {
    hash: string;
    ref: string | null;
    files: { path: string; added: number | null; removed: number | null }[];
  } | null;
  checks: { name: string; status: string; summary: string | null }[];
  policy: { rule: string; status: string; summary: string | null }[];
  sandbox: { level: string | null; mode: string | null; controls: Record<string, string> } | null;
  adapter: Record<string, string> | null;
  cost: Record<string, string> | null;
}

export function evidenceView(body: unknown): EvidenceView {
  const b = (body && typeof body === 'object' ? body : {}) as Row;
  const entries = (Array.isArray(b.automated_evidence) ? b.automated_evidence : []) as Entry[];
  const named = (name: string) => entries.find((e) => e.name === name);

  const probeEntry = entries.find((e) => e.kind === 'probe');
  const probe = probeEntry
    ? {
        status: probeEntry.status,
        result_id: probeEntry.artifact_ref?.startsWith('result:') ? probeEntry.artifact_ref.slice(7) : null,
        summary: probeEntry.summary ?? null,
        ran_at: probeEntry.ran_at ?? null,
      }
    : null;

  const intent = (b.intent_payload ?? {}) as Row;
  const blast = (b.blast_radius ?? {}) as Row;
  const d = (b.diff ?? null) as { ref: string; hash: string; files: DiffFile[] } | null;
  const diff: EvidenceView['diff'] = d
    ? { hash: d.hash, ref: d.ref, files: d.files.map((f) => ({ ...f })) }
    : intent.format === 'diff' && typeof intent.payload_hash === 'string'
      ? {
          hash: intent.payload_hash,
          ref: typeof intent.rendered_ref === 'string' ? intent.rendered_ref : null,
          files: (Array.isArray(blast.affected) ? (blast.affected as string[]) : []).map((path) => ({
            path,
            added: null,
            removed: null,
          })),
        }
      : null;

  const checks = entries
    .filter((e) => e.kind === 'tests' && e.name.startsWith(EVIDENCE_NAMES.checkPrefix))
    .map((e) => ({
      name: e.name.slice(EVIDENCE_NAMES.checkPrefix.length),
      status: e.status,
      summary: e.summary ?? null,
    }));
  const policy = entries
    .filter((e) => e.kind === 'diff_policy' && e.name.startsWith(EVIDENCE_NAMES.policyPrefix))
    .map((e) => ({
      rule: e.name.slice(EVIDENCE_NAMES.policyPrefix.length),
      status: e.status,
      summary: e.summary ?? null,
    }));

  const prov = (b.provenance ?? {}) as Row;
  const pSandbox = prov.sandbox as { level: string; controls: Record<string, string> } | undefined;
  const sb = named(EVIDENCE_NAMES.sandbox);
  const fromEntry = sb ? parseKv(sb.summary) : undefined;
  let sandbox: EvidenceView['sandbox'] = null;
  if (pSandbox) {
    sandbox = { level: pSandbox.level, mode: fromEntry?.mode ?? null, controls: { ...pSandbox.controls } };
  } else if (fromEntry) {
    const { level, mode, ...controls } = fromEntry;
    sandbox = { level: level ?? null, mode: mode ?? null, controls };
  }
  const pAdapter = prov.adapter as Record<string, string> | undefined;
  const ad = named(EVIDENCE_NAMES.adapter);
  const cost = named(EVIDENCE_NAMES.cost);
  return {
    probe,
    diff,
    checks,
    policy,
    sandbox,
    adapter: pAdapter ? { ...pAdapter } : ad ? parseKv(ad.summary) : null,
    cost: cost ? parseKv(cost.summary) : null,
  };
}
