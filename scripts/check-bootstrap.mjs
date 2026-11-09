#!/usr/bin/env node
// check-bootstrap: verify_probe of row WS-P0-002. Tier 0.
// Checks that the agent instructions, PR template and CODEOWNERS are installed and agree:
//   1. AGENTS.md, CLAUDE.md, CODEOWNERS and .github/pull_request_template.md exist.
//   2. CLAUDE.md imports AGENTS.md (a line "@AGENTS.md").
//   3. CODEOWNERS has no placeholder owner (@OWNER) and every rule names at least one @owner.
//   4. Every Tier 0 path listed in AGENTS.md rule 3 is covered by its own CODEOWNERS rule
//      (the catch-all "*" does not count).
//   5. The AGENTS.md rule 3 list equals the TIER0 list enforced by scripts/check-tier0.mjs.
//   6. The PR template has the ledger-row, probe-output and tier-touched fields.
// Usage: node scripts/check-bootstrap.mjs [repo-root]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TIER0 } from './check-tier0.mjs';

export const REQUIRED_FILES = ['AGENTS.md', 'CLAUDE.md', 'CODEOWNERS', '.github/pull_request_template.md'];
export const TEMPLATE_FIELDS = [
  ['ledger-row', /^##\s+Ledger row/m],
  ['probe-output', /^##\s+Probe[\s\S]*Before[\s\S]*After/m],
  ['tier-touched', /^##\s+Tier touched/m],
];

// Returns the backticked paths of AGENTS.md rule 3 ("Do not modify: `a`, `b`, ... `z`.").
export function tier0FromAgents(text) {
  const line = text.split('\n').find((l) => /^3\.\s+\*\*Tier 0 paths/.test(l));
  if (!line) return null;
  const start = line.indexOf('Do not modify:');
  if (start < 0) return null;
  const parts = line.slice(start + 'Do not modify:'.length).split('`');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out.push(parts[i]);
    else if (i > 0 && /\.\s/.test(parts[i])) break;
  }
  return out;
}

export function parseCodeowners(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern, owners };
    });
}

const norm = (p) => p.replace(/^\//, '');

// Covered when a non-catch-all rule names the same path, or a directory that contains it.
export function coveredBy(tier0Path, rules) {
  const t = norm(tier0Path);
  return (
    rules.find((r) => {
      const p = norm(r.pattern);
      if (p === '*' || p === '**') return false;
      if (p === t) return true;
      if (p.endsWith('/') && !p.includes('*') && t.startsWith(p)) return true;
      return false;
    }) ?? null
  );
}

export function checkBootstrap(root) {
  const errors = [];
  for (const f of REQUIRED_FILES) if (!existsSync(join(root, f))) errors.push(`missing ${f}`);
  if (errors.length) return errors;
  const read = (f) => readFileSync(join(root, f), 'utf8');

  if (!/^@AGENTS\.md\s*$/m.test(read('CLAUDE.md')))
    errors.push('CLAUDE.md does not import AGENTS.md (@AGENTS.md)');

  const co = read('CODEOWNERS');
  if (/@OWNER\b/.test(co)) errors.push('CODEOWNERS still has the @OWNER placeholder');
  const rules = parseCodeowners(co);
  for (const r of rules) {
    if (!r.owners.some((o) => /^@[A-Za-z0-9][\w.-]*(\/[\w.-]+)?$/.test(o))) {
      errors.push(`CODEOWNERS rule "${r.pattern}" names no @owner`);
    }
  }

  const listed = tier0FromAgents(read('AGENTS.md'));
  if (!listed || listed.length === 0) {
    errors.push('AGENTS.md rule 3 ("Tier 0 paths are Owner-only ... Do not modify: ...") not found');
  } else {
    for (const p of listed) {
      if (!coveredBy(p, rules)) errors.push(`Tier 0 path ${p} (AGENTS.md rule 3) has no CODEOWNERS rule`);
    }
    const a = new Set(listed);
    const b = new Set(TIER0);
    for (const p of a) if (!b.has(p)) errors.push(`${p} is in AGENTS.md rule 3 but not in check-tier0 TIER0`);
    for (const p of b) if (!a.has(p)) errors.push(`${p} is in check-tier0 TIER0 but not in AGENTS.md rule 3`);
  }

  const tpl = read('.github/pull_request_template.md');
  for (const [name, re] of TEMPLATE_FIELDS)
    if (!re.test(tpl)) errors.push(`PR template lacks the ${name} field`);
  return errors;
}

export function main(argv = process.argv.slice(2), out = console) {
  const root = resolve(argv[0] ?? process.env.FW_REPO_ROOT ?? process.cwd());
  const errors = checkBootstrap(root);
  if (errors.length) {
    for (const e of errors) out.error(`check-bootstrap: ${e}`);
    return 1;
  }
  out.log('check-bootstrap: ok (instructions, CODEOWNERS, PR template and Tier 0 lists agree)');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
