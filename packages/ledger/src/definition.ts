// Row definition files: ledger/rows/<CODE>.json, one row each, in the shape of a row of
// ledger/backlog/CORE-BACKLOG.json and never carrying status (status lives only in the database).
// This module checks a definition and maps it onto the ledger-row and probe contracts.
//
// The probe of a row is derived from its `verify_probe` command line only. Its definition is the
// probe contract object without content_hash; probe_hash = sha256(canonicalJson(definition)), and
// the same value is the contract's content_hash. Anything that changes the definition changes the
// hash, and sync refuses a changed hash for a row the database already holds.
import type { OwnerRef, Priority, Probe, Size } from '@fw/contracts';
import { canonicalJson, sha256Hex } from '@fw/eventlog';
import { isRowCode, rowIdFromCode } from './ids.ts';

export const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3'];
export const SIZES: readonly Size[] = ['XS', 'S', 'M', 'L', 'XL'];
const SUITABILITY = ['agent', 'pair', 'human'] as const;
export type Suitability = (typeof SUITABILITY)[number];

/** Wall-clock limit for a row probe derived from `verify_probe`. */
export const DEFAULT_PROBE_TIMEOUT_S = 600;

/** The fields of a row file that the ledger reads. Other fields of the backlog shape are allowed and ignored. */
export interface RowDefinition {
  id: string;
  title: string;
  priority: Priority;
  size: Size;
  lane: string;
  depends_on: string[];
  verify_probe: string;
  acceptance: string[];
  files_hint: string[];
  agent_suitability: Suitability;
  core_milestone?: string;
  description?: string;
}

/** A probe definition: the probe contract without content_hash (that is what gets hashed). */
export type ProbeDefinition = Omit<Probe, 'content_hash'>;

export type DefinitionCheck = { ok: true; def: RowDefinition } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Checks one parsed row file. `fileName`, when given, must be `<id>.json`. */
export function parseRowDefinition(raw: unknown, fileName?: string): DefinitionCheck {
  if (!isObj(raw)) return { ok: false, errors: ['a row file must hold one JSON object'] };
  const errors: string[] = [];
  const id = raw.id;
  if (typeof id !== 'string' || !isRowCode(id))
    errors.push('id must be a row code such as FW-C-019 or WS-P0-016');
  if (fileName !== undefined && typeof id === 'string' && fileName !== `${id}.json`)
    errors.push(`file name ${fileName} does not match id ${String(id)}`);
  if ('status' in raw) errors.push('row files never carry status; status lives only in the ledger database');
  const title = raw.title;
  if (typeof title !== 'string' || title.length < 3 || title.length > 200)
    errors.push('title must be a string of 3 to 200 characters');
  if (!PRIORITIES.includes(raw.priority as Priority))
    errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (!SIZES.includes(raw.size as Size)) errors.push(`size must be one of ${SIZES.join(', ')}`);
  if (typeof raw.lane !== 'string' || raw.lane.length < 1 || raw.lane.length > 60)
    errors.push('lane must be a string of 1 to 60 characters');
  const deps = raw.depends_on ?? [];
  if (!isStrArray(deps) || !deps.every(isRowCode)) errors.push('depends_on must be a list of row codes');
  else if (typeof id === 'string' && deps.includes(id)) errors.push('a row cannot depend on itself');
  if (typeof raw.verify_probe !== 'string' || raw.verify_probe.trim() === '')
    errors.push('verify_probe must be a non-empty command line');
  const acceptance = raw.acceptance ?? [];
  if (!isStrArray(acceptance)) errors.push('acceptance must be a list of strings');
  const files = raw.files_hint ?? [];
  if (!isStrArray(files)) errors.push('files_hint must be a list of path globs');
  const suit = raw.agent_suitability ?? 'agent';
  if (!SUITABILITY.includes(suit as Suitability))
    errors.push(`agent_suitability must be one of ${SUITABILITY.join(', ')}`);
  for (const k of ['core_milestone', 'description'] as const)
    if (raw[k] !== undefined && typeof raw[k] !== 'string') errors.push(`${k} must be a string`);
  if (errors.length) return { ok: false, errors };
  const def: RowDefinition = {
    id: id as string,
    title: title as string,
    priority: raw.priority as Priority,
    size: raw.size as Size,
    lane: raw.lane as string,
    depends_on: [...(deps as string[])],
    verify_probe: (raw.verify_probe as string).trim(),
    acceptance: [...(acceptance as string[])],
    files_hint: [...(files as string[])],
    agent_suitability: suit as Suitability,
  };
  if (typeof raw.core_milestone === 'string') def.core_milestone = raw.core_milestone;
  if (typeof raw.description === 'string') def.description = raw.description;
  return { ok: true, def };
}

/** Splits a verify_probe command line into argv. Quoting is not supported: probes are plain commands. */
export function probeArgv(commandLine: string): string[] {
  return commandLine.trim().split(/\s+/);
}

/** The probe definition derived from a row's verify_probe. Depends on nothing else in the row. */
export function probeFromDefinition(def: Pick<RowDefinition, 'id' | 'verify_probe'>): ProbeDefinition {
  const measures = `The row's verify probe \`${def.verify_probe}\` exits 0 on the merged artifact.`;
  return {
    id: `prb_${rowIdFromCode(def.id).slice(3)}`,
    version: 1,
    kind: 'command',
    measures: measures.length > 300 ? `${measures.slice(0, 297)}...` : measures,
    runs_against: 'merged_artifact',
    command: { argv: probeArgv(def.verify_probe), cwd: '.', timeout_s: DEFAULT_PROBE_TIMEOUT_S },
    expected: { exit_code: 0 },
    owner_trust_tier: 0,
  };
}

/** probe_hash = sha256(canonicalJson(probe definition)). Any content_hash field is ignored. */
export function probeHash(probe: ProbeDefinition | Probe): string {
  const { content_hash: _ignored, ...definition } = probe as Probe;
  return sha256Hex(canonicalJson(definition));
}

/** The probe contract object (definition plus content_hash). */
export function contractProbe(probe: ProbeDefinition): Probe {
  return { ...probe, content_hash: probeHash(probe) };
}

/** RACI owner of a row: agent rows are owned by the program lead agent, pair and human rows by the Owner. */
export function rowOwner(
  def: Pick<RowDefinition, 'agent_suitability'>,
  ownerId: string,
  leadAgentId: string,
): OwnerRef {
  return def.agent_suitability === 'agent'
    ? { kind: 'agent', id: leadAgentId }
    : { kind: 'owner', id: ownerId };
}
