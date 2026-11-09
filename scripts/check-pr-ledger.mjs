#!/usr/bin/env node
// check-pr-ledger: a pull request names exactly one ledger row (AGENTS.md rule 5). Tier 0.
//
// Env:
//   PR_BODY        the PR description
//   PR_LABELS      comma-separated label names
//   FW_REPO_ROOT   optional repo root; when ledger/rows/ holds row files, the named row must exist
// The one exemption is the label "bootstrap" (the single PR that creates the repository skeleton,
// before any row file exists).
// Exit: 0 ok, 1 zero or several row ids, or an unknown row id.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROW_ID_RE = /\b(FW-C-\d{3}|WS-P\d-\d{3})\b/g;
export const EXEMPT_LABEL = 'bootstrap';

export function stripComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

export function rowIds(body, labels) {
  const ids = new Set();
  for (const m of stripComments(body).matchAll(ROW_ID_RE)) ids.add(m[1]);
  for (const l of labels) for (const m of l.matchAll(ROW_ID_RE)) ids.add(m[1]);
  return [...ids].sort();
}

export function parseLabels(s) {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function knownRows(root) {
  const dir = join(root, 'ledger/rows');
  if (!existsSync(dir)) return null;
  const ids = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5));
  return ids.length ? new Set(ids) : null;
}

export function check({ body, labels, root }) {
  if (labels.includes(EXEMPT_LABEL)) {
    return { ok: true, message: `exempt: label "${EXEMPT_LABEL}"` };
  }
  const ids = rowIds(body, labels);
  if (ids.length === 0) {
    return {
      ok: false,
      message:
        'no ledger row named. Put exactly one row id (FW-C-nnn or WS-Pn-nnn) in the PR body or a label.',
    };
  }
  if (ids.length > 1) {
    return { ok: false, message: `${ids.length} ledger rows named (${ids.join(', ')}). One row per PR.` };
  }
  const known = root ? knownRows(root) : null;
  if (known && !known.has(ids[0])) {
    return { ok: false, message: `row ${ids[0]} has no definition file ledger/rows/${ids[0]}.json` };
  }
  return { ok: true, message: `row ${ids[0]}` };
}

export function main(env = process.env, out = console) {
  const root = resolve(env.FW_REPO_ROOT ?? process.cwd());
  const res = check({ body: env.PR_BODY ?? '', labels: parseLabels(env.PR_LABELS), root });
  if (res.ok) out.log(`check-pr-ledger: ok, ${res.message}`);
  else out.error(`check-pr-ledger: ${res.message}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
