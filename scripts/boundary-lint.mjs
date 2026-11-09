#!/usr/bin/env node
// Dependency-boundary lint. Enforces PACKAGE-LAYOUT.txt: which @fw/* package may import which.
// Checks both package.json dependencies and import specifiers in src/ and test/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED = {
  contracts: [],
  eventlog: ['contracts'],
  ledger: ['contracts', 'eventlog'],
  policy: ['contracts', 'eventlog', 'ledger'],
  adapters: ['contracts'],
  daemon: ['contracts', 'eventlog', 'ledger', 'policy', 'adapters'],
  cli: ['contracts'],
  web: ['contracts'],
};
// Vendor names may appear only in packages/adapters (AGENTS.md architecture guardrails).
const VENDOR_RE = /\b(anthropic|openai|claude|codex)\b/i;
const VENDOR_FREE = ['contracts', 'eventlog', 'ledger', 'policy'];

const root = process.argv[2] ?? process.cwd();
const pkgsDir = join(root, 'packages');
const errors = [];

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const present = readdirSync(pkgsDir).filter((n) => statSync(join(pkgsDir, n)).isDirectory());
for (const pkg of present) {
  if (!(pkg in ALLOWED)) {
    errors.push(`packages/${pkg}: not one of the eight Core packages`);
    continue;
  }
  const allowed = new Set(ALLOWED[pkg]);
  const manifest = JSON.parse(readFileSync(join(pkgsDir, pkg, 'package.json'), 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const dep of Object.keys(deps)) {
    const m = dep.match(/^@fw\/(.+)$/);
    if (m && !allowed.has(m[1])) errors.push(`packages/${pkg}/package.json: may not depend on ${dep}`);
  }
  for (const sub of ['src', 'test']) {
    let files = [];
    try {
      files = walk(join(pkgsDir, pkg, sub));
    } catch {
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"]@fw\/([a-z-]+)/g)) {
        if (m[1] !== pkg && !allowed.has(m[1]))
          errors.push(`${file.slice(root.length + 1)}: imports @fw/${m[1]}`);
      }
      if (
        /['"](?:\.\.\/)+(?:packages\/)?(?:contracts|eventlog|ledger|policy|adapters|daemon|cli|web)\/src/.test(
          text,
        )
      ) {
        errors.push(`${file.slice(root.length + 1)}: reaches into another package by relative path`);
      }
      if (VENDOR_FREE.includes(pkg) && sub === 'src') {
        const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const v = code.match(VENDOR_RE);
        if (v) errors.push(`${file.slice(root.length + 1)}: vendor name "${v[0]}" outside packages/adapters`);
      }
    }
  }
}

if (errors.length) {
  console.error(`boundary lint: ${errors.length} violation(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`boundary lint: ok (${present.length} packages)`);
