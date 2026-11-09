#!/usr/bin/env node
// Generates TypeScript types from the Core JSON Schemas (contracts-core/json-schema, Draft 2020-12).
//
//   node packages/contracts/scripts/gen-types.mjs           write packages/contracts/src/generated/*.ts
//   node packages/contracts/scripts/gen-types.mjs --check   exit 1 if the committed output has drifted
//
// The output is committed. A test runs --check so a schema edit without regenerating fails CI.
// Validation is done by Ajv at runtime; these types are a compile-time convenience and are
// deliberately a little looser than the schemas (patterns, lengths, if/then rules are not typed).
// An object gets an index signature only when the schema says additionalProperties is true or a schema.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const DEFAULT_SCHEMA_DIR = resolve(here, '../../../contracts-core/json-schema');
const OUT_DIR = resolve(here, '../src/generated');

const pascal = (s) =>
  s
    .replace(/\.json$/, '')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');

const EM_DASH = String.fromCharCode(0x2014);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k) => (IDENT.test(k) ? k : JSON.stringify(k));

function cleanDoc(text) {
  return String(text).replace(/\*\//g, '* /').replaceAll(EM_DASH, ', ').replace(/\s+/g, ' ').trim();
}

function doc(schema, indent) {
  if (!schema || typeof schema !== 'object' || !schema.description) return '';
  return `${indent}/** ${cleanDoc(schema.description)} */\n`;
}

const SHAPE_KEYS = [
  'type',
  'enum',
  'const',
  'properties',
  'items',
  '$ref',
  'oneOf',
  'anyOf',
  'allOf',
  'additionalProperties',
];

/** Converts one schema node to a TS type expression. ctx tracks imports for the current file. */
function toType(schema, ctx, indent) {
  if (schema === true || schema === undefined) return 'unknown';
  if (schema === false) return 'never';
  if (!SHAPE_KEYS.some((k) => k in schema)) return 'unknown';

  if (schema.$ref) return refType(schema.$ref, ctx);
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');

  const parts = [];
  const isObject =
    schema.type === 'object' || (!schema.type && (schema.properties || 'additionalProperties' in schema));
  if (isObject) parts.push(objectType(schema, ctx, indent));
  else if (Array.isArray(schema.type)) {
    parts.push(schema.type.map((t) => primitive(t, schema, ctx, indent)).join(' | '));
  } else if (schema.type) {
    parts.push(primitive(schema.type, schema, ctx, indent));
  }

  for (const comb of ['oneOf', 'anyOf']) {
    if (schema[comb]) {
      const alts = schema[comb].map((s) => toType(s, ctx, indent)).filter((t) => t !== 'unknown');
      if (alts.length) parts.push(`(${alts.join(' | ')})`);
    }
  }
  if (schema.allOf) {
    for (const s of schema.allOf) {
      const t = toType(s, ctx, indent);
      if (t !== 'unknown') parts.push(t);
    }
  }
  if (!parts.length) return 'unknown';
  return parts.join(' & ');
}

function primitive(t, schema, ctx, indent) {
  switch (t) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const inner = toType(schema.items, ctx, indent);
      return /^[A-Za-z0-9_]+$/.test(inner) ? `${inner}[]` : `Array<${inner}>`;
    }
    case 'object':
      return objectType(schema, ctx, indent);
    default:
      throw new Error(`unsupported type ${t}`);
  }
}

function objectType(schema, ctx, indent) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  let out = '{\n';
  for (const [name, sub] of Object.entries(props)) {
    out += doc(sub, inner);
    out += `${inner}${key(name)}${required.has(name) ? '' : '?'}: ${toType(sub, ctx, inner)};\n`;
  }
  const ap = schema.additionalProperties;
  if (ap === true) out += `${inner}[key: string]: unknown;\n`;
  else if (ap && typeof ap === 'object') {
    const t = Object.keys(props).length ? 'unknown' : toType(ap, ctx, inner);
    out += `${inner}[key: string]: ${t};\n`;
  }
  out += `${indent}}`;
  return out === `{\n${indent}}` ? 'Record<string, never>' : out;
}

function refType(ref, ctx) {
  const [file, frag] = ref.split('#');
  if (!file) {
    const m = /^\/\$defs\/(.+)$/.exec(frag ?? '');
    if (!m) throw new Error(`unsupported local ref ${ref} in ${ctx.file}`);
    return pascal(m[1]);
  }
  if (frag) {
    const m = /^\/\$defs\/(.+)$/.exec(frag);
    if (!m) throw new Error(`unsupported ref ${ref} in ${ctx.file}`);
    const name = pascal(m[1]);
    if (file !== ctx.file) ctx.addImport(file, name);
    return name;
  }
  const name = pascal(file);
  if (file !== ctx.file) ctx.addImport(file, name);
  return name;
}

function moduleName(file) {
  return file.replace(/\.json$/, '');
}

function genFile(file, schema) {
  const imports = new Map();
  const ctx = {
    file,
    addImport(f, name) {
      if (!imports.has(f)) imports.set(f, new Set());
      imports.get(f).add(name);
    },
  };
  let body = '';
  if (schema.$defs) {
    for (const [name, def] of Object.entries(schema.$defs)) {
      body += `\n${doc(def, '')}export type ${pascal(name)} = ${toType(def, ctx, '')};\n`;
    }
  }
  const hasShape = SHAPE_KEYS.some((k) => k in schema && k !== '$defs');
  if (hasShape) {
    const title = schema.title ? `${schema.title}. ` : '';
    const d = schema.description ? cleanDoc(schema.description) : '';
    body += `\n/** ${cleanDoc(title + d)} Schema: ${schema.$id} */\nexport type ${pascal(file)} = ${toType(schema, ctx, '')};\n`;
  }
  let head = `// GENERATED by packages/contracts/scripts/gen-types.mjs from contracts-core/json-schema/${file}.\n// Do not edit by hand. Regenerate with: node packages/contracts/scripts/gen-types.mjs\n`;
  const importLines = [...imports.keys()]
    .sort()
    .map((f) => `import type { ${[...imports.get(f)].sort().join(', ')} } from './${moduleName(f)}.ts';`);
  if (importLines.length) head += `\n${importLines.join('\n')}\n`;
  return head + body;
}

export function generate(schemaDir = DEFAULT_SCHEMA_DIR) {
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out = new Map();
  const exportsList = [];
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), 'utf8'));
    out.set(`${moduleName(file)}.ts`, genFile(file, schema));
    exportsList.push(`export type * from './${moduleName(file)}.ts';`);
  }
  out.set(
    'index.ts',
    `// GENERATED by packages/contracts/scripts/gen-types.mjs. Do not edit by hand.\n${exportsList.join('\n')}\n`,
  );
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const out = generate();
  const drift = [];
  if (!check) mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, text] of out) {
    const p = join(OUT_DIR, name);
    const current = existsSync(p) ? readFileSync(p, 'utf8') : null;
    if (current === text) continue;
    if (check) drift.push(name);
    else writeFileSync(p, text);
  }
  const present = existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : [];
  for (const name of present) {
    if (out.has(name)) continue;
    if (check) drift.push(`${name} (stale, no schema)`);
    else unlinkSync(join(OUT_DIR, name));
  }
  if (drift.length) {
    console.error(`gen-types: generated types drifted from the schemas: ${drift.join(', ')}`);
    console.error('run: node packages/contracts/scripts/gen-types.mjs');
    process.exit(1);
  }
  console.log(`gen-types: ${check ? 'up to date' : 'wrote'} ${out.size} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
