import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createValidator,
  type EventEnvelope,
  PACKAGE,
  SCHEMA_IDS,
  UnknownSchemaError,
  validate,
} from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const core = join(root, 'contracts-core');
const manifest = JSON.parse(readFileSync(join(core, 'examples/manifest.json'), 'utf8')) as {
  examples: Record<string, string>;
  invalid: Record<string, string>;
};
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const schemaOf = (rel: string) =>
  rel
    .split('/')
    .pop()!
    .replace(/\.json$/, '');

test('@fw/contracts resolves', () => {
  expect(PACKAGE).toBe('@fw/contracts');
});

describe('schemas', () => {
  test('all 17 schema files load and compile under Ajv 2020-12 strict mode', () => {
    const v = createValidator();
    const files = readdirSync(join(core, 'json-schema')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(17);
    expect([...v.ids.keys()].sort()).toEqual([...SCHEMA_IDS].sort());
  });

  test('accepts short id, file name and full $id', () => {
    const ex = read(join(core, 'examples/28-budget.json'));
    expect(validate('budget', ex).ok).toBe(true);
    expect(validate('budget.json', ex).ok).toBe(true);
    expect(validate('https://contracts.invalid/fw/v1/budget.json', ex).ok).toBe(true);
    expect(() => validate('no-such-schema', ex)).toThrow(UnknownSchemaError);
  });
});

describe('examples (mirrors contracts-core/validate.py)', () => {
  test('manifest covers every example file', () => {
    const valid = readdirSync(join(core, 'examples')).filter((f) => f !== 'manifest.json');
    const invalid = readdirSync(join(core, 'examples-invalid'));
    expect(Object.keys(manifest.examples).sort()).toEqual(valid.sort());
    expect(Object.keys(manifest.invalid).sort()).toEqual(invalid.sort());
    expect(valid).toHaveLength(17);
    expect(invalid).toHaveLength(4);
  });

  for (const [name, rel] of Object.entries(manifest.examples)) {
    test(`valid ${name} is accepted by ${schemaOf(rel)}`, () => {
      const r = validate(schemaOf(rel), read(join(core, 'examples', name)));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  for (const [name, rel] of Object.entries(manifest.invalid)) {
    test(`invalid ${name} is rejected by ${schemaOf(rel)}`, () => {
      const r = validate(schemaOf(rel), read(join(core, 'examples-invalid', name)));
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });
  }

  test('date-time format is asserted', () => {
    const ev = read(join(core, 'examples/20-event-envelope.json')) as EventEnvelope;
    expect(validate('event-envelope', { ...ev, ts: 'yesterday' }).ok).toBe(false);
  });
});

describe('generated types', () => {
  test('committed types match the schemas (gen-types --check)', () => {
    const script = join(import.meta.dirname, '../scripts/gen-types.mjs');
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('an example is assignable to its generated type', () => {
    const ev = read(join(core, 'examples/20-event-envelope.json')) as EventEnvelope;
    expect(ev.actor.kind).toBe('system');
  });
});
