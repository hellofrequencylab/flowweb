// JSON Schema validation for the Core contracts (Draft 2020-12, Ajv strict mode).
// The schemas are read from the repo-root contracts-core/json-schema directory, which is the
// pinned source of truth (see contracts-core/SCHEMA-SNAPSHOT.sha256). Nothing here edits them.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export const DEFAULT_SCHEMA_DIR = resolve(import.meta.dirname, '../../../contracts-core/json-schema');

/** The 17 schema files (16 contracts plus common.json), by short id. */
export const SCHEMA_IDS = [
  'approval-request',
  'approval-response',
  'budget',
  'common',
  'decision-card',
  'escalation-message',
  'event-envelope',
  'evidence-bundle',
  'ledger-row',
  'merge-slot-grant',
  'policy-rule',
  'probe',
  'run-result',
  'status-report',
  'stream-definition',
  'vendor-adapter-input',
  'work-order',
] as const;
export type SchemaId = (typeof SCHEMA_IDS)[number];

export interface ValidationError {
  /** JSON Pointer into the value, '' for the root. */
  path: string;
  message: string;
  keyword: string;
}

export type ValidationResult = { ok: true; errors: [] } | { ok: false; errors: ValidationError[] };

export class UnknownSchemaError extends Error {
  constructor(id: string) {
    super(`unknown schema id: ${id}`);
    this.name = 'UnknownSchemaError';
  }
}

// RFC 3339 date-time (the schemas say "UTC RFC 3339"; any offset is accepted, as RFC 3339 allows).
const DATE_TIME =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

function isUri(s: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export interface Validator {
  validate(schemaId: string, value: unknown): ValidationResult;
  /** The $id of each loaded schema, keyed by short id. */
  readonly ids: ReadonlyMap<string, string>;
}

/** Normalises 'event-envelope', 'event-envelope.json' or the full $id to the short id. */
function shortId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last.replace(/\.json$/, '');
}

/** Loads every *.json schema in schemaDir into one Ajv 2020 instance and compiles each. */
export function createValidator(schemaDir: string = DEFAULT_SCHEMA_DIR): Validator {
  // Strict where the schemas allow it. strictRequired and strictTypes stay off: the schemas use the
  // standard 2020-12 if/then pattern (a `then` that requires a property defined on the parent, and
  // `if` branches without a `type`), which those two checks flag although it is valid and intended.
  const ajv = new Ajv2020({
    strictSchema: true,
    strictNumbers: true,
    strictTuples: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  ajv.addFormat('date-time', DATE_TIME);
  ajv.addFormat('uri', isUri);
  const ids = new Map<string, string>();
  for (const file of readdirSync(schemaDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const doc = JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as { $id: string };
    ajv.addSchema(doc);
    ids.set(shortId(file), doc.$id);
  }
  const compiled = new Map<string, ValidateFunction>();
  for (const [short, $id] of ids) {
    const fn = ajv.getSchema($id);
    if (!fn) throw new Error(`schema ${short} did not compile`);
    compiled.set(short, fn);
  }
  return {
    ids,
    validate(schemaId: string, value: unknown): ValidationResult {
      const fn = compiled.get(shortId(schemaId));
      if (!fn) throw new UnknownSchemaError(schemaId);
      if (fn(value)) return { ok: true, errors: [] };
      return { ok: false, errors: (fn.errors ?? []).map(toError) };
    },
  };
}

function toError(e: ErrorObject): ValidationError {
  return { path: e.instancePath, message: e.message ?? e.keyword, keyword: e.keyword };
}

let defaultValidator: Validator | undefined;

/** Validates value against one Core schema. Throws UnknownSchemaError for an id that is not loaded. */
export function validate(schemaId: SchemaId | (string & {}), value: unknown): ValidationResult {
  defaultValidator ??= createValidator();
  return defaultValidator.validate(schemaId, value);
}
