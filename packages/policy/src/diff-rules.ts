// FW-C-009 (Tier 0, Owner-authorised): the content rules of the diff policy, driven by the rules data
// file policy/rules/diff-policy.json. Pure functions over a unified diff; the only IO is reading that
// file, and a missing or invalid file throws, which evaluateDiffPolicy turns into a deny.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type RowSize = 'S' | 'M' | 'L';

export interface DiffPolicyRules {
  deleted_test: { test_paths: RegExp[]; test_case: RegExp };
  skipped_test: { added_line: RegExp; exclude: RegExp[] };
  config_relaxation: { paths: RegExp[]; added_line: RegExp };
  size_over_cap: { max: Record<RowSize, number>; unknown_size: RowSize; exclude: RegExp[] };
  new_dependency: { manifests: { glob: RegExp; format: 'package_json' | 'requirements_txt' }[] };
}

export const DIFF_POLICY_RULES_PATH = fileURLToPath(
  new URL('../../../policy/rules/diff-policy.json', import.meta.url),
);

type Glob = (g: string) => RegExp;

const SIZES = ['S', 'M', 'L'] as const;
const FORMATS = ['package_json', 'requirements_txt'] as const;

function fail(what: string): never {
  throw new Error(`diff-policy rules: ${what}`);
}
function obj(v: unknown, what: string): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : fail(`missing ${what}`);
}
function list(v: unknown, what: string, glob: Glob): RegExp[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) fail(`${what} must be a list of strings`);
  return (v as string[]).map(glob);
}
function regex(v: unknown, what: string): RegExp {
  return typeof v === 'string' ? new RegExp(v) : fail(`missing ${what}`);
}

/** Parses and validates the rules file text. Throws on anything missing or malformed (fail closed). */
export function parseDiffPolicyRules(text: string, glob: Glob): DiffPolicyRules {
  const doc = obj(JSON.parse(text), 'document');
  if (doc.version !== 1) fail('version must be 1');
  const r = obj(doc.rules, 'rules');
  const [, , dt, st, cr, sz, nd] = [
    'forbidden_path',
    'outside_allowed_files',
    'deleted_test',
    'skipped_test',
    'config_relaxation',
    'size_over_cap',
    'new_dependency',
  ].map((id) => obj(r[id], id)) as Record<string, unknown>[];
  const max = obj(sz!.max_changed_lines, 'size_over_cap.max_changed_lines');
  const caps = Object.fromEntries(
    SIZES.map((s) => [s, Number.isInteger(max[s]) && (max[s] as number) > 0 ? max[s] : fail(`cap ${s}`)]),
  ) as Record<RowSize, number>;
  const unknown = SIZES.find((s) => s === sz!.unknown_size) ?? fail('unknown_size must be S, M or L');
  if (!Array.isArray(nd!.manifests)) fail('new_dependency.manifests must be a list');
  const manifests = (nd!.manifests as Record<string, unknown>[]).map((m) => ({
    glob: typeof m.glob === 'string' ? glob(m.glob) : fail('a manifest needs a glob'),
    format: FORMATS.find((f) => f === m.format) ?? fail(`unknown manifest format ${String(m.format)}`),
  }));
  return {
    deleted_test: {
      test_paths: list(dt!.test_paths, 'deleted_test.test_paths', glob),
      test_case: regex(dt!.test_case_regex, 'deleted_test.test_case_regex'),
    },
    skipped_test: {
      added_line: regex(st!.added_line_regex, 'skipped_test.added_line_regex'),
      exclude: list(st!.exclude ?? [], 'skipped_test.exclude', glob),
    },
    config_relaxation: {
      paths: list(cr!.paths, 'config_relaxation.paths', glob),
      added_line: regex(cr!.added_line_regex, 'config_relaxation.added_line_regex'),
    },
    size_over_cap: {
      max: caps,
      unknown_size: unknown,
      exclude: list(sz!.exclude ?? [], 'size_over_cap.exclude', glob),
    },
    new_dependency: { manifests },
  };
}

export function loadDiffPolicyRules(glob: Glob, path: string = DIFF_POLICY_RULES_PATH): DiffPolicyRules {
  return parseDiffPolicyRules(readFileSync(path, 'utf8'), glob);
}

/** One file of a unified diff: its paths and the added and removed lines (without the +/- marker). */
export interface PatchFile {
  path: string;
  old_path: string | null;
  added: string[];
  removed: string[];
  binary: boolean;
}

function unquote(p: string): string {
  if (p.startsWith('"')) throw new Error(`quoted path in patch header: ${p}`);
  return p;
}

/** Parses `git diff` output (run it with `-c core.quotePath=false`). A quoted header path throws. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const guess = rest.length % 2 === 1 ? rest.slice(2, (rest.length - 1) / 2) : rest;
      cur = { path: unquote(guess), old_path: null, added: [], removed: [], binary: false };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk) {
      if (line.startsWith('+')) cur.added.push(line.slice(1));
      else if (line.startsWith('-')) cur.removed.push(line.slice(1));
      continue;
    }
    if (line.startsWith('--- ') && line !== '--- /dev/null')
      cur.old_path = unquote(line.slice(4)).replace(/^a\//, '');
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null')
      cur.path = unquote(line.slice(4)).replace(/^b\//, '');
    else if (line.startsWith('rename from ')) cur.old_path = unquote(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) cur.path = unquote(line.slice('rename to '.length));
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') cur.binary = true;
  }
  for (const f of files) if (f.old_path === f.path) f.old_path = null;
  return files;
}

/** A dependency manifest's content before and after the change; null when the file does not exist. */
export interface ManifestContent {
  path: string;
  before: string | null;
  after: string | null;
}

export function dependencyNames(
  text: string | null,
  format: 'package_json' | 'requirements_txt',
): Set<string> {
  const names = new Set<string>();
  if (text === null) return names;
  if (format === 'package_json') {
    const doc = JSON.parse(text) as Record<string, unknown>;
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = doc[k];
      if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) names.add(n);
    }
    return names;
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const name = line.split(/[\s<>=!~;[@]/)[0];
    if (name) names.add(name.toLowerCase().replace(/[-_.]+/g, '-'));
  }
  return names;
}
