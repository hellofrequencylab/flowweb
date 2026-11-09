// Claude Code CLI flag verification. Nothing here is trusted from memory: every flag the adapter
// puts in argv must be found in the installed CLI's `--help` text by the preflight, or the run
// fails closed. Verified against Claude Code 2.1.319 on 2026-11-09.
import { AdapterError } from '../sdk/errors.ts';

export interface HelpIndex {
  /** Long flag name (with the leading dashes) to the help text block describing it. */
  flags: Map<string, string>;
}

/** Index option lines of commander-style help output ("  -p, --print   Print response ..."). */
export function parseHelp(text: string): HelpIndex {
  const flags = new Map<string, string>();
  let current: string[] = [];
  let block: string[] = [];
  const flush = () => {
    for (const f of current) flags.set(f, block.join(' ').replace(/\s+/g, ' ').trim());
  };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s{1,8}(-[A-Za-z], )?(--[A-Za-z][A-Za-z0-9-]*)((?:, --[A-Za-z][A-Za-z0-9-]*)*)/);
    if (m) {
      flush();
      current = [m[2]!, ...(m[3] ? [...m[3].matchAll(/--[A-Za-z][A-Za-z0-9-]*/g)].map((x) => x[0]) : [])];
      block = [line];
    } else if (/^\S/.test(line)) {
      flush();
      current = [];
      block = [];
    } else {
      block.push(line);
    }
  }
  flush();
  return { flags };
}

export interface FlagRequirement {
  flag: string;
  /** Values that must be listed in the flag's help block (for example a choice). */
  mentions?: string[];
  why: string;
}

/** Flags every run uses. Missing any of these fails the preflight closed. */
export const REQUIRED_FLAGS: readonly FlagRequirement[] = [
  { flag: '--print', why: 'headless, non-interactive mode' },
  { flag: '--output-format', mentions: ['stream-json'], why: 'line-delimited JSON events' },
  { flag: '--verbose', why: 'stream-json in print mode needs verbose output' },
  { flag: '--bare', why: 'API-key-only auth, no hooks, no CLAUDE.md auto-discovery' },
  { flag: '--session-id', why: 'session id assigned by the adapter and stored before the run starts' },
  {
    flag: '--permission-mode',
    mentions: ['acceptEdits'],
    why: 'edits allowed without an interactive prompt',
  },
  { flag: '--max-budget-usd', why: 'vendor-side dollar cap below the run budget' },
  { flag: '--json-schema', why: 'schema-constrained structured report' },
];

/** Flags used only when the input asks for them. Verified at argv build time, also fail closed. */
export const CONDITIONAL_FLAGS: readonly FlagRequirement[] = [
  { flag: '--resume', why: 'resume_session_id in the input' },
  { flag: '--model', why: 'model chosen by routing' },
  { flag: '--allowed-tools', why: 'tool allowlist for the run' },
];

/** Hardening flags used when present; their absence is recorded but not fatal. */
export const OPTIONAL_FLAGS: readonly FlagRequirement[] = [
  { flag: '--permission-prompts', mentions: ['none'], why: 'deny anything that would prompt' },
];

function satisfied(index: HelpIndex, r: FlagRequirement): boolean {
  const block = index.flags.get(r.flag);
  if (block === undefined) return false;
  return (r.mentions ?? []).every((m) => block.includes(`"${m}"`) || block.includes(m));
}

/** Returns the verified flag set or throws AdapterError('missing_flag'). */
export function verifyFlags(helpText: string): string[] {
  const index = parseHelp(helpText);
  const missing = REQUIRED_FLAGS.filter((r) => !satisfied(index, r));
  if (missing.length > 0) {
    throw new AdapterError(
      'missing_flag',
      `claude --help lacks required flag(s): ${missing.map((m) => m.flag + (m.mentions ? ` (${m.mentions.join(', ')})` : '')).join(', ')}`,
    );
  }
  const verified = REQUIRED_FLAGS.map((r) => r.flag);
  for (const r of [...CONDITIONAL_FLAGS, ...OPTIONAL_FLAGS]) if (satisfied(index, r)) verified.push(r.flag);
  return verified;
}
