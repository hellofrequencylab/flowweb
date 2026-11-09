// The `view` the API offers beside an evidence bundle: the same facts the PR comment shows, derived
// back from where the builder (src/pipeline/evidence.ts) encodes them inside the contract's shape.
// Bundles that lack an entry (a closing bundle, an older bundle) get null for that part.
import { EVIDENCE_NAMES, parseKv } from '../pipeline/evidence.ts';

type Row = Record<string, unknown>;

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
  diff: { hash: string; ref: string | null; files: string[] } | null;
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
  const diff =
    intent.format === 'diff' && typeof intent.payload_hash === 'string'
      ? {
          hash: intent.payload_hash,
          ref: typeof intent.rendered_ref === 'string' ? intent.rendered_ref : null,
          files: Array.isArray(blast.affected) ? (blast.affected as string[]) : [],
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

  const sb = named(EVIDENCE_NAMES.sandbox);
  let sandbox: EvidenceView['sandbox'] = null;
  if (sb) {
    const { level, mode, ...controls } = parseKv(sb.summary);
    sandbox = { level: level ?? null, mode: mode ?? null, controls };
  }
  const ad = named(EVIDENCE_NAMES.adapter);
  const cost = named(EVIDENCE_NAMES.cost);
  return {
    probe,
    diff,
    checks,
    policy,
    sandbox,
    adapter: ad ? parseKv(ad.summary) : null,
    cost: cost ? parseKv(cost.summary) : null,
  };
}
