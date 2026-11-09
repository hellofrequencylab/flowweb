#!/usr/bin/env node
// Fails if any file in src/ other than the token layer contains a colour literal.
// Keeps the design system swappable: replace src/ui-kit/tokens.css and nothing else.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const allow = new Set(['ui-kit/tokens.css']);
const colour = /#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;
const bad = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(css|tsx?|jsx?)$/.test(f)) {
      const rel = p.slice(root.length + 1);
      if (allow.has(rel)) continue;
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (colour.test(line.replace(/&#\d+;|"#[\w-]+"|`#[\w-]+`|href="#\w+"/g, '')))
            bad.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
  }
})(root);
if (bad.length) {
  console.error(`Colour literals outside src/ui-kit/tokens.css:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log('check:tokens ok (no colour literals outside the token layer)');
