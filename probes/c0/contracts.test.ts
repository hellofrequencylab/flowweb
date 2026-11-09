// Probe c0/contracts (FW-C-002; backlog verify_probe kernel/contracts-core).
// Surface: validate(schemaId, value) exported by packages/contracts/src/index.ts (schemaId is the
// schema's $id), packages/contracts/scripts/gen-types.mjs (generate(schemaDir) and --check), and the
// CI workflow. The contracts stay at the repo root (decision 1): contracts-core/json-schema/ with
// contracts-core/SCHEMA-SNAPSHOT.sha256, not a vendored copy under packages/contracts/ (decision 4).
// Acceptance:
//   - all 17 schema files compile, the 17 valid examples pass and the 4 invalid examples are rejected
//   - generated types are committed (packages/contracts/src/generated/) and drift from the schemas
//     fails CI (gen-types --check, run by pnpm test in CI; a schema edit changes the generated output)
//   - a schema edit without a matching SCHEMA-SNAPSHOT.sha256 update fails CI (the snapshot check
//     catches an edited copy, and CI runs it)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { requireExport, root, tmpDir } from './_lib.mjs';

const core = join(root, 'contracts-core');
const isValid = (r: unknown) =>
  r === true || (typeof r === 'object' && r !== null && ((r as { ok?: boolean }).ok === true || (r as { valid?: boolean }).valid === true));

describe('c0/contracts', () => {
  test('validate() accepts every valid example and rejects every invalid one', async () => {
    const validate = (await requireExport('contracts', 'validate', 'FW-C-002')) as (id: string, v: unknown) => unknown;
    const manifest = JSON.parse(readFileSync(join(core, 'examples/manifest.json'), 'utf8'));
    const idOf = (rel: string) => JSON.parse(readFileSync(join(core, 'examples', rel), 'utf8')).$id as string;
    const schemaFiles = readdirSync(join(core, 'json-schema')).filter((n) => n.endsWith('.json'));
    expect(schemaFiles.length, 'contracts-core ships 17 schemas').toBe(17);
    for (const f of schemaFiles) {
      const id = JSON.parse(readFileSync(join(core, 'json-schema', f), 'utf8')).$id;
      expect(() => validate(id, {}), `schema ${f} compiles and is addressable by its $id`).not.toThrow();
    }
    const valid = Object.entries(manifest.examples as Record<string, string>);
    const invalid = Object.entries(manifest.invalid as Record<string, string>);
    expect(valid.length).toBe(17);
    expect(invalid.length).toBe(4);
    for (const [ex, schema] of valid) {
      const v = JSON.parse(readFileSync(join(core, 'examples', ex), 'utf8'));
      expect(isValid(validate(idOf(schema), v)), `valid example ${ex}`).toBe(true);
    }
    for (const [ex, schema] of invalid) {
      const v = JSON.parse(readFileSync(join(core, 'examples-invalid', ex), 'utf8'));
      expect(isValid(validate(idOf(schema), v)), `invalid example ${ex} must be rejected`).toBe(false);
    }
  });

  test('the snapshot catches an unrecorded schema edit, and CI runs the check', () => {
    const snap = join(core, 'SCHEMA-SNAPSHOT.sha256');
    expect(existsSync(snap), 'contracts-core/SCHEMA-SNAPSHOT.sha256 exists').toBe(true);
    const ok = spawnSync('sha256sum', ['-c', '--quiet', snap], { cwd: join(core, 'json-schema'), encoding: 'utf8' });
    expect(ok.status, `snapshot matches: ${ok.stdout}${ok.stderr}`).toBe(0);
    const tmp = tmpDir('snap');
    cpSync(join(core, 'json-schema'), tmp, { recursive: true });
    writeFileSync(join(tmp, 'budget.json'), `${readFileSync(join(tmp, 'budget.json'), 'utf8')} `);
    const bad = spawnSync('sha256sum', ['-c', '--quiet', snap], { cwd: tmp, encoding: 'utf8' });
    expect(bad.status, 'an edited schema fails the snapshot check').not.toBe(0);
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci, 'CI runs the snapshot check').toContain('sha256sum -c ../SCHEMA-SNAPSHOT.sha256');
  });

  test('generated types are committed and drift fails CI', async () => {
    const gen = join(root, 'packages/contracts/src/generated');
    expect(existsSync(gen), 'packages/contracts/src/generated/ exists').toBe(true);
    const committed = readdirSync(gen).filter((n) => n.endsWith('.ts'));
    expect(committed.length, 'generated .ts files exist').toBeGreaterThan(17);
    const script = join(root, 'packages/contracts/scripts/gen-types.mjs');
    const check = spawnSync(process.execPath, [script, '--check'], { cwd: root, encoding: 'utf8' });
    expect(check.status, `gen-types --check: ${check.stderr}`).toBe(0);

    // A schema edit must change the generated output, so the committed types would drift.
    const { generate } = (await import(script)) as { generate: (dir: string) => Map<string, string> };
    const tmp = tmpDir('gen');
    cpSync(join(core, 'json-schema'), tmp, { recursive: true });
    const budget = JSON.parse(readFileSync(join(tmp, 'budget.json'), 'utf8'));
    budget.properties.probe_added_field = { type: 'string' };
    writeFileSync(join(tmp, 'budget.json'), JSON.stringify(budget, null, 2));
    const drifted = [...generate(tmp)].filter(([name, text]) => readFileSync(join(gen, name), 'utf8') !== text);
    expect(drifted.map(([n]) => n), 'the edited schema drifts from the committed types').toContain('budget.ts');
    expect(readFileSync(join(root, 'packages/contracts/test/contracts.test.ts'), 'utf8'), 'pnpm test runs gen-types --check').toContain(
      "'--check'",
    );
    expect(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), 'CI runs pnpm test').toContain('run: pnpm test');
  });
});
