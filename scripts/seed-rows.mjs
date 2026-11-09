#!/usr/bin/env node
// seed-rows: writes ledger/rows/<ID>.json (row DEFINITIONS, one file per row) from
// ledger/backlog/CORE-BACKLOG.json. Tier 0: owned by the Owner.
//
// Rules this script enforces:
//   - A row file never carries status or any other state field (status lives only in the ledger DB).
//   - Every depends_on id names a row that exists, and the dependency graph is acyclic.
//   - The fields that ledger-row.json defines for a row (title, priority, lane, size) satisfy that
//     schema's property rules. The whole ledger-row.json shape is NOT applied: it describes the
//     database record (id lr_*, status, project_id, owner, probe object, created_at all required,
//     additionalProperties false), not a definition file keyed by a backlog id. See probes/c0/README.md.
//   - Idempotent: a second run writes nothing. Output is stable (fixed key order, 2-space JSON, LF).
//
// Usage: node scripts/seed-rows.mjs [--check] [--root <dir>]
//   --check   write nothing; exit 1 if any file would be created, changed or is stale.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fields that describe state, not definition. Never written to a row file.
export const STATE_FIELDS = [
  'status',
  'last_probe',
  'premise',
  'merged_sha',
  'evidence_bundle_id',
  'closed_at',
  'updated_at',
  'watch_until',
];

// Output key order. Unknown definition keys from the backlog are appended in sorted order.
const KEY_ORDER = [
  'id',
  'title',
  'core_milestone',
  'phase',
  'epic',
  'priority',
  'size',
  'lane',
  'agent_suitability',
  'gate',
  'depends_on',
  'description',
  'acceptance',
  'verify_probe',
  'files_hint',
  'origin',
  'derived_from',
  'core_adaptation',
  'full_depends_on',
  'full_files_hint',
];

export const ROW_ID_RE = /^(FW-C-\d{3}|WS-P\d-\d{3})$/;

export function toDefinition(row) {
  const out = {};
  const keys = [
    ...KEY_ORDER.filter((k) => k in row),
    ...Object.keys(row)
      .filter((k) => !KEY_ORDER.includes(k))
      .sort(),
  ];
  for (const k of keys) {
    if (STATE_FIELDS.includes(k)) continue;
    out[k] = row[k];
  }
  return out;
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function resolveRef(schemas, ref) {
  // Supports "common.json#/$defs/name" and local "#/$defs/name" style refs used by ledger-row.json.
  const [file, pointer] = ref.split('#');
  const doc = schemas[file];
  if (!doc) throw new Error(`unresolved schema ref ${ref}`);
  return pointer
    .split('/')
    .filter(Boolean)
    .reduce((o, k) => o?.[k], doc);
}

// Minimal checker for the keywords that the row-level properties of ledger-row.json use.
export function checkProperty(schemas, sub, value, path) {
  const errs = [];
  if (sub.$ref) return checkProperty(schemas, resolveRef(schemas, sub.$ref), value, path);
  if (sub.enum && !sub.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (sub.type === 'string') {
    if (typeof value !== 'string') errs.push(`${path}: not a string`);
    else {
      if (sub.minLength !== undefined && value.length < sub.minLength)
        errs.push(`${path}: shorter than ${sub.minLength}`);
      if (sub.maxLength !== undefined && value.length > sub.maxLength)
        errs.push(`${path}: longer than ${sub.maxLength}`);
      if (sub.pattern && !new RegExp(sub.pattern).test(value))
        errs.push(`${path}: does not match ${sub.pattern}`);
    }
  }
  for (const k of Object.keys(sub)) {
    if (!['$ref', 'enum', 'type', 'minLength', 'maxLength', 'pattern', 'description'].includes(k)) {
      errs.push(`${path}: seed-rows cannot check schema keyword "${k}"; extend the checker`);
    }
  }
  return errs;
}

// Fields shared by a definition file and ledger-row.json with the same meaning.
export const SCHEMA_CHECKED_FIELDS = ['title', 'priority', 'lane', 'size'];

export function validateRows(rows, schemas) {
  const errors = [];
  const ids = new Set();
  const rowSchema = schemas['ledger-row.json'];
  for (const r of rows) {
    if (!ROW_ID_RE.test(r.id ?? '')) errors.push(`${r.id}: id does not match ${ROW_ID_RE}`);
    if (ids.has(r.id)) errors.push(`${r.id}: duplicate id`);
    ids.add(r.id);
    for (const f of SCHEMA_CHECKED_FIELDS) {
      if (!(f in r)) {
        errors.push(`${r.id}: missing ${f}`);
        continue;
      }
      errors.push(...checkProperty(schemas, rowSchema.properties[f], r[f], `${r.id}.${f}`));
    }
    if (typeof r.verify_probe !== 'string' || r.verify_probe.trim() === '') {
      errors.push(`${r.id}: missing verify_probe`);
    }
    if (!Array.isArray(r.acceptance) || r.acceptance.length === 0) errors.push(`${r.id}: missing acceptance`);
    if (!Array.isArray(r.depends_on)) errors.push(`${r.id}: depends_on must be an array`);
  }
  for (const r of rows) {
    for (const d of r.depends_on ?? []) {
      if (!ids.has(d)) errors.push(`${r.id}: depends_on ${d} which is not a row`);
    }
  }
  const cycle = findCycle(rows);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return errors;
}

export function findCycle(rows) {
  const deps = new Map(rows.map((r) => [r.id, r.depends_on ?? []]));
  const state = new Map(); // 1 visiting, 2 done
  const stack = [];
  function visit(id) {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

export function render(row) {
  return `${JSON.stringify(toDefinition(row), null, 2)}\n`;
}

export function seed({ root, check = false, log = console.log }) {
  const backlog = loadJson(join(root, 'ledger/backlog/CORE-BACKLOG.json'));
  const schemaDir = join(root, 'contracts-core/json-schema');
  const schemas = {};
  for (const f of readdirSync(schemaDir).filter((n) => n.endsWith('.json')))
    schemas[f] = loadJson(join(schemaDir, f));
  const rows = backlog.rows;
  if (!Array.isArray(rows)) throw new Error('CORE-BACKLOG.json has no rows array');
  if (backlog.meta?.row_count !== undefined && backlog.meta.row_count !== rows.length) {
    return { ok: false, errors: [`meta.row_count ${backlog.meta.row_count} != ${rows.length} rows`] };
  }
  const errors = validateRows(rows, schemas);
  if (errors.length) return { ok: false, errors };

  const outDir = join(root, 'ledger/rows');
  if (!check) mkdirSync(outDir, { recursive: true });
  const changed = [];
  const expected = new Set();
  for (const r of rows) {
    const file = `${r.id}.json`;
    expected.add(file);
    const p = join(outDir, file);
    const body = render(r);
    const before = existsSync(p) ? readFileSync(p, 'utf8') : null;
    if (before === body) continue;
    changed.push(`${before === null ? 'create' : 'update'} ${file}`);
    if (!check) writeFileSync(p, body);
  }
  // Row files with no backlog row are reported, never deleted (removing a row is an Owner decision).
  const stale = existsSync(outDir)
    ? readdirSync(outDir).filter((n) => n.endsWith('.json') && !expected.has(n))
    : [];
  for (const s of stale) changed.push(`stale ${s} (no row in CORE-BACKLOG.json; not deleted)`);
  log(
    `seed-rows: ${rows.length} rows valid, dependency graph acyclic; ${changed.length ? changed.length : 'no'} change(s)${check ? ' (check mode)' : ''}`,
  );
  for (const c of changed) log(`  ${c}`);
  return { ok: check ? changed.length === 0 : stale.length === 0, errors: [], changed, rows: rows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = resolve(rootIdx >= 0 ? args[rootIdx + 1] : join(import.meta.dirname, '..'));
  const res = seed({ root, check: args.includes('--check') });
  for (const e of res.errors) console.error(`seed-rows: ${e}`);
  process.exit(res.ok ? 0 : 1);
}
