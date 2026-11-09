#!/usr/bin/env node
// check-tier0: fails when a pull request authored by an agent identity changes a Tier 0 path.
// Tier 0 itself. Human PRs that touch these paths still need a code-owner review (branch protection);
// this check is the second line for agent identities.
//
// Env:
//   PR_AUTHOR        login of the PR author (github.event.pull_request.user.login)
//   BASE_SHA         PR base sha
//   HEAD_SHA         PR head sha
//   FW_AGENT_LOGINS  optional, comma-separated extra agent logins (case-insensitive).
//                    Any login containing "[bot]" is always an agent.
// Args:
//   --only <p1,p2>   restrict the check to these Tier 0 patterns (used by the probe-immutability job)
//   --repo <dir>     git working directory (default: cwd)
// Exit: 0 clean, 1 an agent PR touched a Tier 0 path, 2 missing or bad input (fails closed).
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Must match AGENTS.md rule 3 exactly (scripts/check-bootstrap.mjs verifies this) and be covered
// by CODEOWNERS. A trailing "/" means the whole directory; "*" matches within one path segment.
export const TIER0 = [
  'probes/',
  'policy/',
  'config/',
  'ledger/rows/',
  'ledger/backlog/',
  'scripts/check-*',
  'scripts/probe-*.sh',
  'scripts/probe.mjs',
  'scripts/seed-rows.mjs',
  'scripts/test/',
  'tooling/requirements-ci.txt',
  '.github/',
  'CODEOWNERS',
  'AGENTS.md',
  'CLAUDE.md',
  '.gitleaks.toml',
  'contracts-core/',
  'schema.core.sql',
  'tests/schema_core_test.py',
  'packages/policy/',
  'packages/eventlog/src/chain.ts',
  'packages/contracts/sql/',
  'packages/contracts/json-schema/',
  'packages/contracts/SCHEMA-SNAPSHOT.sha256',
];

export function patternToRegExp(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return pattern.endsWith('/') ? new RegExp(`^${esc}`) : new RegExp(`^${esc}$`);
}

export function matchTier0(file, patterns = TIER0) {
  const f = file.replace(/^\.\//, '');
  return patterns.find((p) => patternToRegExp(p).test(f)) ?? null;
}

export function agentLogins(env = process.env) {
  return (env.FW_AGENT_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAgent(login, env = process.env) {
  const l = String(login ?? '')
    .trim()
    .toLowerCase();
  if (l.includes('[bot]')) return true;
  return agentLogins(env).includes(l);
}

export function changedFiles(base, head, cwd = process.cwd()) {
  // Three-dot diff: changes on head since it forked from base. --no-renames lists both sides of a
  // rename, so moving a Tier 0 file away is caught too.
  const r = spawnSync('git', ['diff', '--name-only', '--no-renames', `${base}...${head}`], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git diff failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

export function evaluate({ author, files, env = process.env, patterns = TIER0 }) {
  const hits = files.map((f) => ({ file: f, pattern: matchTier0(f, patterns) })).filter((h) => h.pattern);
  const agent = isAgent(author, env);
  return { agent, hits, ok: !(agent && hits.length > 0) };
}

export function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const onlyIdx = argv.indexOf('--only');
  const repoIdx = argv.indexOf('--repo');
  const cwd = repoIdx >= 0 ? argv[repoIdx + 1] : process.cwd();
  let patterns = TIER0;
  if (onlyIdx >= 0) {
    patterns = (argv[onlyIdx + 1] ?? '').split(',').filter(Boolean);
    const unknown = patterns.filter((p) => !TIER0.includes(p));
    if (patterns.length === 0 || unknown.length) {
      out.error(
        `check-tier0: --only takes Tier 0 patterns from the TIER0 list; unknown: ${unknown.join(', ')}`,
      );
      return 2;
    }
  }
  const { PR_AUTHOR: author, BASE_SHA: base, HEAD_SHA: head } = env;
  if (!author || !base || !head) {
    out.error('check-tier0: PR_AUTHOR, BASE_SHA and HEAD_SHA must all be set (failing closed)');
    return 2;
  }
  let files;
  try {
    files = changedFiles(base, head, cwd);
  } catch (e) {
    out.error(`check-tier0: ${e.message} (failing closed; is the checkout fetch-depth 0?)`);
    return 2;
  }
  const res = evaluate({ author, files, env, patterns });
  const scope = onlyIdx >= 0 ? ` [${patterns.join(', ')}]` : '';
  if (!res.ok) {
    out.error(`check-tier0${scope}: agent identity "${author}" changed ${res.hits.length} Tier 0 path(s):`);
    for (const h of res.hits) out.error(`  ${h.file}  (Tier 0: ${h.pattern})`);
    out.error('Tier 0 paths are Owner-only (AGENTS.md rule 3). Stop and write a decision note instead.');
    return 1;
  }
  out.log(
    `check-tier0${scope}: ok (${files.length} changed file(s), author "${author}" is ${res.agent ? 'an agent' : 'not an agent'}, ${res.hits.length} Tier 0 path(s) touched)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
