// Work order compiler (WS-P0-040): ledger row + repo state -> a work-order.json object.
// Pure and deterministic: the same input gives the same order, byte for byte (the caller supplies
// the id, version and clock). scope.touches comes from the row's files_hint (a restrictive default
// when there is none), acceptance from the probe, budget caps and TTL from the core-policy size table.
import { readFileSync } from 'node:fs';
import type { BudgetCaps, Size, WorkOrder } from '@fw/contracts';
import { validate } from '@fw/contracts';
import { canonicalJson, nowIso, sha256Hex } from '@fw/eventlog';
import type { ProbeDefinition } from '../definition.ts';
import { LedgerError } from '../errors.ts';
import type { CorePolicy } from '../policy.ts';
import type { BriefAnswers } from '../projects/projects.ts';

/**
 * Tier 0 paths a worker never touches, merged with the policy's tier0 list: policy/tier0-paths.json,
 * the one Tier 0 list (AGENTS.md rule 3), in glob form (`dir/` becomes `dir/**`). It is data, so this
 * package stays vendor-blind. A missing or malformed file throws at import (fail closed).
 */
export const ALWAYS_FORBIDDEN: readonly string[] = Object.freeze(
  (
    JSON.parse(readFileSync(new URL('../../../../policy/tier0-paths.json', import.meta.url), 'utf8')) as {
      paths: string[];
    }
  ).paths.map((p) => (p.endsWith('/') ? `${p}**` : p)),
);

export interface CompileInput {
  id: string;
  version: number;
  issuedAt: Date;
  row: {
    id: string;
    code: string;
    title: string;
    size: Size;
    project_id: string;
    stream_id: string;
  };
  probe: ProbeDefinition;
  /** From the row definition file when available. */
  files_hint?: string[];
  acceptance?: string[];
  baseCommit: string;
  policy: CorePolicy;
  roles: { doer: string; verifier: string; approver: string };
  /** The project's complete brief from the Owner (FW-C-040), copied word for word; absent when none. */
  brief?: BriefAnswers;
}

/** The voice goes to style; the other four answers go to notes, each labelled with its question. */
function briefConstraints(b: BriefAnswers | undefined): { style?: string[]; notes: string[] } {
  if (!b) return { notes: [] };
  return {
    style: [`Voice, from the Owner's project brief: ${b.voice}`],
    notes: [
      `From the Owner's project brief. What the project is: ${b.what}`,
      `Who it is for: ${b.who}`,
      `What the agents must never do on it: ${b.never}`,
      `What done looks like: ${b.done}`,
    ],
  };
}

export function workOrderHash(wo: Omit<WorkOrder, 'content_hash'> | WorkOrder): string {
  const { content_hash: _ignored, ...rest } = wo as WorkOrder;
  return sha256Hex(canonicalJson(rest));
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

/** The caps and TTL for a row's size. Throws SIZE_NOT_DISPATCHABLE when the size table has no caps (XL). */
export function dispatchRule(
  policy: CorePolicy,
  code: string,
  size: Size,
): { caps: BudgetCaps; ttl_hours: number } {
  const rule = policy.sizes[size];
  if (!rule?.caps || rule.ttl_hours === undefined)
    throw new LedgerError(
      'SIZE_NOT_DISPATCHABLE',
      `${code} is size ${size}, which is not dispatchable in Core${rule?.note ? ` (${rule.note})` : ''}; split the row`,
      { code, size, policy: policy.path },
    );
  return { caps: rule.caps, ttl_hours: rule.ttl_hours };
}

/** Self-verification is refused: the verifier must be a different agent from the doer. */
export function assertNotSelfVerify(code: string, doer: string, verifier: string): void {
  if (doer === verifier)
    throw new LedgerError(
      'SELF_VERIFY',
      `self-verification refused: ${doer} cannot be both doer and verifier of ${code}`,
      {
        code,
        agent: doer,
      },
    );
}

export function compileWorkOrder(input: CompileInput): WorkOrder {
  const { row, probe, policy, roles } = input;
  assertNotSelfVerify(row.code, roles.doer, roles.verifier);
  const rule = dispatchRule(policy, row.code, row.size);
  const command = (probe.command?.argv ?? []).join(' ');
  const touches = input.files_hint?.length ? [...input.files_hint] : [`docs/notes/${row.code}/**`];
  const forbidden = [...new Set([...ALWAYS_FORBIDDEN, ...policy.tier0_paths])].sort();
  const claims = input.acceptance?.length ? input.acceptance : [probe.measures];
  const brief = briefConstraints(input.brief);
  const issuedAt = nowIso(input.issuedAt);
  const expiresAt = nowIso(new Date(input.issuedAt.getTime() + rule.ttl_hours * 3600_000));
  const body: Omit<WorkOrder, 'content_hash'> = {
    id: input.id,
    version: input.version,
    title: clip(row.title, 200),
    project_id: row.project_id,
    stream_id: row.stream_id,
    ledger_row_id: row.id,
    base_commit: input.baseCommit,
    goal: clip(`${row.title}. Done when \`${command}\` passes on the merged artifact.`, 400),
    context_links: [row.id, `ledger/rows/${row.code}.json`],
    scope: { touches, forbidden },
    constraints: {
      no_new_dependencies: true,
      max_diff_lines: policy.max_diff_lines,
      max_files: policy.max_files,
      notes: [
        'Never edit, skip or loosen the row probe.',
        'Edit only the paths in scope.touches.',
        ...brief.notes,
      ],
      ...(brief.style ? { style: brief.style } : {}),
    },
    acceptance: claims.slice(0, 999).map((claim, i) => ({
      id: `AC${i + 1}`,
      claim: claim.length >= 5 ? claim : `${claim} (probe)`,
      probe_command: command,
      expected: `exit ${probe.expected.exit_code ?? 0}`,
    })),
    autonomy_tier: 'L2',
    action_class: 'code_write_sandbox',
    environment: 'sandbox',
    budget: { caps: rule.caps, ttl_hours: rule.ttl_hours },
    escalate_if: [
      {
        condition: 'The change needs a path outside scope.touches or any forbidden path',
        to: 'program_lead',
      },
      { condition: 'Blocked or ambiguous after 2 attempts', to: 'chief_of_staff' },
      { condition: 'Any security, privacy or external-communication risk is noticed', to: 'owner' },
    ],
    output: { required_artifacts: ['pull_request'], result_schema: 'run-result.json' },
    roles: { doer: roles.doer, verifier: roles.verifier, approver: { kind: 'owner', id: roles.approver } },
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const wo: WorkOrder = { ...body, content_hash: workOrderHash(body) };
  const check = validate('work-order', wo);
  if (!check.ok)
    throw new LedgerError('WORK_ORDER_INVALID', `compiled work order for ${row.code} is not valid`, {
      errors: check.errors,
    });
  return wo;
}
