// The Tier 0 list the pipeline checks diffs against: CORE_TIER0_PATHS, read from policy/tier0-paths.json,
// the one list, which already names the agent instruction files. AGENT_INSTRUCTION_FILES is kept for the
// worktree step that lists which of them a checkout has; the union below is a no-op guard.
import { CORE_TIER0_PATHS } from '@fw/policy';

export const AGENT_INSTRUCTION_FILES: readonly string[] = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

export const TIER0_PATHS: readonly string[] = Object.freeze([
  ...new Set([...CORE_TIER0_PATHS, ...AGENT_INSTRUCTION_FILES]),
]);
