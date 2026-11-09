// Probe c0/contracts (FW-C-002; backlog verify_probe kernel/contracts-core).
// Surface: `validate(schemaId, value)` exported by packages/contracts/src/index.ts, where schemaId is
// the schema's `$id` (for example https://contracts.invalid/fw/v1/work-order.json). The result counts
// as valid when it is `true` or an object with `ok: true` or `valid: true`.
// Acceptance:
//   - all 17 schema files compile (each $id is accepted by validate), the 17 valid examples pass and
//     the 4 invalid examples are rejected
//   - the vendored copy packages/contracts/json-schema/ is byte-identical to contracts-core/json-schema/
//     and packages/contracts/SCHEMA-SNAPSHOT.sha256 matches it
//   - a schema edit without a matching snapshot update fails the snapshot check
//   - generated types are committed (packages/contracts/src/generated/) and typecheck passes
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { missing, requireExport, root, tmpDir } from './_lib.mjs';

const core = join(root, 'contracts-core');
const vendored = join(root, 'packages/contracts/json-schema');
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

  test('vendored schemas equal contracts-core and the snapshot catches an unrecorded edit', () => {
    if (!existsSync(vendored)) missing('packages/contracts/json-schema/ does not exist (vendored contracts, FW-C-002)');
    const snap = join(root, 'packages/contracts/SCHEMA-SNAPSHOT.sha256');
    if (!existsSync(snap)) missing('packages/contracts/SCHEMA-SNAPSHOT.sha256 does not exist (FW-C-002)');
    for (const f of readdirSync(join(core, 'json-schema'))) {
      expect(readFileSync(join(vendored, f), 'utf8'), `${f} vendored byte-identical`).toBe(
        readFileSync(join(core, 'json-schema', f), 'utf8'),
      );
    }
    const ok = spawnSync('sha256sum', ['-c', '--quiet', snap], { cwd: vendored, encoding: 'utf8' });
    expect(ok.status, `snapshot matches: ${ok.stdout}${ok.stderr}`).toBe(0);
    const tmp = tmpDir('snap');
    cpSync(vendored, tmp, { recursive: true });
    writeFileSync(join(tmp, 'budget.json'), `${readFileSync(join(tmp, 'budget.json'), 'utf8')} `);
    const bad = spawnSync('sha256sum', ['-c', '--quiet', snap], { cwd: tmp, encoding: 'utf8' });
    expect(bad.status, 'an edited schema fails the snapshot check').not.toBe(0);
  });

  test('generated types are committed', () => {
    const gen = join(root, 'packages/contracts/src/generated');
    if (!existsSync(gen)) missing('packages/contracts/src/generated/ does not exist (generated types, FW-C-002)');
    expect(readdirSync(gen).filter((n) => n.endsWith('.ts')).length, 'generated .ts files exist').toBeGreaterThan(0);
  });
});
