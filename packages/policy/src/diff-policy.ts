// WS-P0-035 (draft for Owner review; packages/policy is Tier 0).
// Diff policy v0 over changed paths: a pure function, no IO. Inputs are the changes of a branch
// (from `git diff --name-status -M base...head`), the Tier 0 path list and the work order's allowed files.
// Any internal error is a deny, never an allow.
import { createHash } from 'node:crypto';

/** The Tier 0 list, read from policy/tier0-paths.json (see tier0.ts). */
export { CORE_TIER0_PATHS } from './tier0.ts';

/** One changed path. `status` is the first letter of git's name-status code (A, M, D, R, C, T, U, X). */
export interface PathChange {
  status: string;
  path: string;
  /** Source path for renames and copies. */
  old_path?: string;
}

export type DiffRule =
  | 'tier0_path'
  | 'outside_allowed_files'
  | 'invalid_path'
  | 'unknown_status'
  | 'policy_error';

export interface DiffViolation {
  path: string;
  rule: DiffRule;
  status?: string;
  detail?: string;
}

export interface DiffVerdict {
  allowed: boolean;
  violations: DiffViolation[];
  /** Number of change entries checked. */
  checked: number;
  /** sha256 over the canonical change list, for the policy.diff_policy_failed payload. */
  diff_hash: string;
}

export interface DiffPolicyInput {
  changes: readonly PathChange[];
  /** Required: there is no silent default, so a caller cannot forget part of the list. */
  tier0Paths: readonly string[];
  /** Work order allowed-files globs. An empty list allows nothing (fail closed). */
  allowedFiles: readonly string[];
}

const KNOWN_STATUS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Converts a path glob to a RegExp. Supports `**`, `*`, `?`, `{a,b}` and a trailing `/` for a directory. */
export function globToRegExp(glob: string, opts: { caseInsensitive?: boolean } = {}): RegExp {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g = `${g}**`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atSegStart = i === 0 || g[i - 1] === '/';
        const atSegEnd = i + 2 === g.length || g[i + 2] === '/';
        i++;
        if (atSegStart && atSegEnd) {
          if (g[i + 1] === '/') {
            i++;
            re += '(?:[^/]+/)*';
          } else {
            re += '.*';
          }
        } else {
          re += '[^/]*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
        continue;
      }
      const alts = g.slice(i + 1, end).split(',');
      re += `(?:${alts.map(escapeRe).join('|')})`;
      i = end;
    } else {
      re += escapeRe(ch);
    }
  }
  return new RegExp(`^${re}$`, opts.caseInsensitive ? 'i' : '');
}

/**
 * A path is invalid when it is empty, absolute, uses backslashes, or contains `.`/`..` segments or NUL.
 * Git never produces these for a normal diff, so seeing one means the input is not trustworthy.
 */
function invalidPathReason(p: string): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'empty path';
  if (p.includes('\0')) return 'NUL in path';
  if (p.startsWith('"')) return 'quoted path (use the -z form)';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return 'dot or empty segment';
  return null;
}

export function diffHash(changes: readonly PathChange[]): string {
  const canon = changes.map((c) => [c.status, c.old_path ?? null, c.path]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** Paths a change touches for policy purposes: the new path, plus the source of a rename. */
function touchedPaths(c: PathChange): string[] {
  if (c.status === 'R' && c.old_path) return [c.old_path, c.path];
  return [c.path];
}

function evaluate(input: DiffPolicyInput): DiffVerdict {
  const tier0 = input.tier0Paths.map((g) => globToRegExp(g, { caseInsensitive: true }));
  const allowed = input.allowedFiles.map((g) => globToRegExp(g));
  const violations: DiffViolation[] = [];
  for (const c of input.changes) {
    const status = typeof c.status === 'string' ? c.status.charAt(0).toUpperCase() : '';
    if (!KNOWN_STATUS.has(status)) {
      violations.push({ path: String(c.path), rule: 'unknown_status', status: String(c.status) });
      continue;
    }
    const norm: PathChange = { ...c, status };
    for (const p of touchedPaths(norm)) {
      const bad = invalidPathReason(p);
      if (bad) {
        violations.push({ path: String(p), rule: 'invalid_path', status, detail: bad });
        continue;
      }
      if (tier0.some((re) => re.test(p))) {
        violations.push({ path: p, rule: 'tier0_path', status });
      } else if (!allowed.some((re) => re.test(p))) {
        violations.push({ path: p, rule: 'outside_allowed_files', status });
      }
    }
  }
  return { allowed: violations.length === 0, violations, checked: input.changes.length, diff_hash: '' };
}

/** Evaluates the diff policy. Deny wins; a thrown error inside the engine becomes a policy_error deny. */
export function evaluateDiffPolicy(input: DiffPolicyInput): DiffVerdict {
  let hash = '';
  try {
    hash = diffHash(input.changes);
    const v = evaluate(input);
    return { ...v, diff_hash: hash };
  } catch (e) {
    return {
      allowed: false,
      violations: [{ path: '*', rule: 'policy_error', detail: e instanceof Error ? e.message : String(e) }],
      checked: 0,
      diff_hash: hash,
    };
  }
}

/**
 * Parses `git diff --name-status` output. Accepts the `-z` form (NUL separated, preferred because it never
 * quotes paths) and the tab separated line form. Rename and copy scores (R100, C075) are reduced to R and C.
 */
export function parseNameStatus(output: string): PathChange[] {
  const changes: PathChange[] = [];
  if (output.includes('\0')) {
    const parts = output.split('\0');
    let i = 0;
    while (i < parts.length) {
      const code = parts[i++];
      if (!code) continue;
      const status = code.charAt(0);
      if (status === 'R' || status === 'C') {
        const old_path = parts[i++] ?? '';
        const path = parts[i++] ?? '';
        changes.push({ status, path, old_path });
      } else {
        changes.push({ status, path: parts[i++] ?? '' });
      }
    }
    return changes;
  }
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const status = (cols[0] ?? '').charAt(0);
    if ((status === 'R' || status === 'C') && cols.length >= 3) {
      changes.push({ status, old_path: cols[1]!, path: cols[2]! });
    } else {
      changes.push({ status, path: cols[1] ?? '' });
    }
  }
  return changes;
}
