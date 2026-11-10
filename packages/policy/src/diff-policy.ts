// WS-P0-035 (draft for Owner review; packages/policy is Tier 0).
// Diff policy v0 over changed paths: a pure function, no IO. Inputs are the changes of a branch
// (from `git diff --name-status -M base...head`), the Tier 0 path list and the work order's allowed files.
// Any internal error is a deny, never an allow.
import { createHash } from 'node:crypto';
import {
  type DiffPolicyRules,
  dependencyNames,
  loadDiffPolicyRules,
  type ManifestContent,
  parsePatch,
  type RowSize,
} from './diff-rules.ts';

/**
 * Tier 0 paths (Owner only), minus per-vendor agent instruction files: this package must stay vendor-blind,
 * so the composition root appends those (see the daemon's TIER0_PATHS). Entry forms: `dir/` matches
 * everything under dir; entries with `*` or `?` are globs (`*` within one segment, `**` across segments);
 * anything else is an exact repo path. Matching ignores case. The row asks for these rules to live in a
 * Tier 0 data file; until that file exists this constant is the version the Owner reviews.
 */
export const CORE_TIER0_PATHS: readonly string[] = Object.freeze([
  'probes/',
  'policy/',
  'config/',
  'ledger/rows/',
  'ledger/backlog/',
  'scripts/check-*',
  'scripts/probe-*',
  '.github/',
  'CODEOWNERS',
  '**/CODEOWNERS',
  'AGENTS.md',
  '.gitleaks.toml',
  '.husky/',
  'packages/policy/',
  'packages/eventlog/src/chain.ts',
  'packages/contracts/sql/',
  'packages/contracts/json-schema/',
  'packages/contracts/SCHEMA-SNAPSHOT.sha256',
  'contracts-core/',
  'schema.core.sql',
  'tests/schema_core_test.py',
]);

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
  | 'deleted_test'
  | 'skipped_test'
  | 'config_relaxation'
  | 'size_over_cap'
  | 'new_dependency'
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
  /**
   * The unified diff of the same change (`git -c core.quotePath=false diff -M base...head`). With it the
   * content rules run (deleted_test on lines, skipped_test, config_relaxation, size_over_cap,
   * new_dependency); without it only the path rules do, which is what the artifact guard's re-check wants.
   */
  patch?: string;
  /** The row's size, for size_over_cap. Unknown sizes get the rules file's unknown_size cap (S). */
  rowSize?: RowSize | string;
  /** Before and after content of every changed dependency manifest. A missing one is a violation. */
  manifests?: readonly ManifestContent[];
  /** The work order allows new dependencies (constraints.no_new_dependencies === false). Default false. */
  allowNewDependencies?: boolean;
  /** Rules to use instead of policy/rules/diff-policy.json (tests). */
  rules?: DiffPolicyRules;
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
  if (input.patch !== undefined) {
    const rules = input.rules ?? defaultRules();
    violations.push(...testPathViolations(input.changes, rules), ...contentViolations(input, rules));
  }
  return { allowed: violations.length === 0, violations, checked: input.changes.length, diff_hash: '' };
}

let cachedRules: DiffPolicyRules | null = null;
function defaultRules(): DiffPolicyRules {
  cachedRules ??= loadDiffPolicyRules((g) => globToRegExp(g, { caseInsensitive: true }));
  return cachedRules;
}

const any = (res: readonly RegExp[], p: string) => res.some((re) => re.test(p));

/** Whether the rules file names this path as a dependency manifest (false when the rules do not load). */
export function isDependencyManifest(path: string, rules?: DiffPolicyRules): boolean {
  try {
    return (rules ?? defaultRules()).new_dependency.manifests.some((m) => m.glob.test(path));
  } catch {
    return false;
  }
}

const statusOf = (c: PathChange) => String(c.status).charAt(0).toUpperCase();
const clip = (l: string | undefined) => (l ?? '').trim().slice(0, 200);

/** deleted_test from the change list: a test file deleted, or renamed to a path that is not a test. */
function testPathViolations(changes: readonly PathChange[], rules: DiffPolicyRules): DiffViolation[] {
  const tests = rules.deleted_test.test_paths;
  const out: DiffViolation[] = [];
  for (const c of changes) {
    const status = statusOf(c);
    if (status === 'D' && any(tests, c.path))
      out.push({ path: c.path, rule: 'deleted_test', status, detail: 'test file deleted' });
    if (status === 'R' && c.old_path && any(tests, c.old_path) && !any(tests, c.path))
      out.push({ path: c.old_path, rule: 'deleted_test', status, detail: `test file renamed to ${c.path}` });
  }
  return out;
}

function contentViolations(input: DiffPolicyInput, rules: DiffPolicyRules): DiffViolation[] {
  const out: DiffViolation[] = [];
  const statuses = new Map(input.changes.map((c) => [c.path, statusOf(c)]));
  const { deleted_test: dt, skipped_test: st, config_relaxation: cr, size_over_cap: sz } = rules;
  let changedLines = 0;
  for (const f of parsePatch(input.patch ?? '')) {
    const status = statuses.get(f.path) ?? 'M';
    const add = (rule: DiffRule, detail: string, path = f.path) => out.push({ path, rule, status, detail });
    if (status !== 'D' && any(dt.test_paths, f.path)) {
      const cases = (lines: string[]) => lines.filter((l) => dt.test_case.test(l)).length;
      const lost = cases(f.removed) - cases(f.added);
      if (lost > 0) add('deleted_test', `${lost} test case(s) removed`);
    }
    const skip = f.added.find((l) => st.added_line.test(l));
    if (skip !== undefined && !any(st.exclude, f.path)) add('skipped_test', clip(skip));
    const isConfig = any(cr.paths, f.path);
    const wasConfig = f.old_path !== null && any(cr.paths, f.old_path);
    if (status === 'D' || (wasConfig && !isConfig)) {
      if (isConfig || wasConfig) add('config_relaxation', 'gate config file removed', f.old_path ?? f.path);
    } else if (isConfig) {
      const removed = f.removed.find((l) => l.trim() !== '');
      const loosened = f.added.find((l) => cr.added_line.test(l));
      if (removed !== undefined) add('config_relaxation', `line removed or changed: ${clip(removed)}`);
      else if (loosened !== undefined) add('config_relaxation', `line added: ${clip(loosened)}`);
    }
    if (!f.binary && !any(sz.exclude, f.path)) changedLines += f.added.length + f.removed.length;
  }
  const size = (['S', 'M', 'L'] as const).find((s) => s === input.rowSize) ?? sz.unknown_size;
  if (changedLines > sz.max[size])
    out.push({
      path: '*',
      rule: 'size_over_cap',
      detail: `${changedLines} changed lines, cap ${sz.max[size]} (${size})`,
    });
  return [...out, ...dependencyViolations(input, rules)];
}

function dependencyViolations(input: DiffPolicyInput, rules: DiffPolicyRules): DiffViolation[] {
  if (input.allowNewDependencies === true) return [];
  const out: DiffViolation[] = [];
  for (const c of input.changes) {
    const status = statusOf(c);
    const spec = rules.new_dependency.manifests.find((m) => m.glob.test(c.path));
    if (!spec || status === 'D') continue;
    const m = input.manifests?.find((x) => x.path === c.path);
    let detail = 'manifest content not supplied';
    if (m) {
      try {
        const before = dependencyNames(m.before, spec.format);
        const added = [...dependencyNames(m.after, spec.format)].filter((n) => !before.has(n));
        detail = added.length ? `new: ${added.sort().join(', ')}` : '';
      } catch (e) {
        detail = `manifest does not parse: ${String(e)}`;
      }
    }
    if (detail) out.push({ path: c.path, rule: 'new_dependency', status, detail });
  }
  return out;
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
