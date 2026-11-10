// Codex CLI flag verification for `codex exec`. Every flag the adapter puts in argv must be found in
// the installed CLI's `codex exec --help` text by the preflight, or the run fails closed.
// Verified against Codex CLI 0.167.0 on 2026-11-09.
import { parseHelp } from '../claude/flags.ts';
import { AdapterError } from '../sdk/errors.ts';

export interface CodexFlagRequirement {
  flag: string;
  /** Values that must be listed in the flag's help block (for example a choice). */
  mentions?: string[];
  why: string;
}

/** Flags every run uses. Missing any of these fails the preflight closed. */
export const CODEX_REQUIRED_FLAGS: readonly CodexFlagRequirement[] = [
  { flag: '--json', why: 'events on stdout as JSONL' },
  { flag: '--output-schema', why: 'schema-constrained structured report' },
  { flag: '--sandbox', mentions: ['workspace-write'], why: 'commands may write only inside the worktree' },
  { flag: '--config', why: 'sandbox mode for resumed runs (`resume` has no --sandbox)' },
];

/** Flags used only when asked for. Verified at argv build time, also fail closed. */
export const CODEX_CONDITIONAL_FLAGS: readonly CodexFlagRequirement[] = [
  { flag: '--model', why: 'model chosen by routing' },
];

/** Hardening flags used when present; their absence is recorded but not fatal. */
export const CODEX_OPTIONAL_FLAGS: readonly CodexFlagRequirement[] = [
  { flag: '--ignore-user-config', why: 'ignore $CODEX_HOME/config.toml; auth still comes from CODEX_HOME' },
];

/** `resume` must be listed as an exec subcommand for resume_session_id to work. */
export const RESUME_COMMAND = 'resume';

function satisfied(flags: Map<string, string>, r: CodexFlagRequirement): boolean {
  const block = flags.get(r.flag);
  if (block === undefined) return false;
  return (r.mentions ?? []).every((m) => block.includes(m));
}

/** Returns the verified flag set (plus `resume` when listed) or throws AdapterError('missing_flag'). */
export function verifyCodexFlags(helpText: string): string[] {
  const { flags } = parseHelp(helpText);
  const missing = CODEX_REQUIRED_FLAGS.filter((r) => !satisfied(flags, r));
  if (missing.length > 0) {
    throw new AdapterError(
      'missing_flag',
      `codex exec --help lacks required flag(s): ${missing.map((m) => m.flag + (m.mentions ? ` (${m.mentions.join(', ')})` : '')).join(', ')}`,
    );
  }
  const verified = CODEX_REQUIRED_FLAGS.map((r) => r.flag);
  for (const r of [...CODEX_CONDITIONAL_FLAGS, ...CODEX_OPTIONAL_FLAGS])
    if (satisfied(flags, r)) verified.push(r.flag);
  if (new RegExp(`^\\s{1,8}${RESUME_COMMAND}\\s`, 'm').test(helpText)) verified.push(RESUME_COMMAND);
  return verified;
}
