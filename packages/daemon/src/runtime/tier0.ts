// The full Tier 0 list the pipeline checks diffs against. packages/policy holds the vendor-blind part;
// agent instruction files are named here because they carry vendor names, which policy may not contain.
import { CORE_TIER0_PATHS } from '@fw/policy';

export const AGENT_INSTRUCTION_FILES: readonly string[] = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

export const TIER0_PATHS: readonly string[] = Object.freeze([
  ...new Set([...CORE_TIER0_PATHS, ...AGENT_INSTRUCTION_FILES]),
]);
