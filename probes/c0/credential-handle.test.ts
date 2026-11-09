// Probe c0/credential-handle (WS-P0-029; backlog verify_probe security/credential-handle).
// Surface: resolveCredential(handle, { home }) exported by packages/daemon/src/index.ts. On headless
// Linux the backend is a 0600 file $FW_HOME/creds/<handle> (core_adaptation); the OS keychain is used
// where present, and tests use the file backend as the keychain stub.
// Acceptance:
//   - a handle resolves to its secret from the stub backend
//   - a missing secret fails with a typed error whose message names the handle and the fix
//   - (added) a credential file readable by group or others is refused
//   - "secret absent from process args and from any file under the run directory" is proven by
//     c0/run-fake-e2e, which scans the run directory and the vendor's argv (see README)
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fakeSecret, freshHome, requireExport } from './_lib.mjs';

type Resolve = (handle: string, o: { home: string }) => string | Promise<string>;

describe('c0/credential-handle', () => {
  test('resolve, typed missing error, permissive file refused', async () => {
    const resolveCredential = (await requireExport('daemon', 'resolveCredential', 'WS-P0-029')) as Resolve;
    const home = freshHome('creds');
    mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
    const secret = fakeSecret('anthropic');
    const f = join(home, 'creds', 'crd_probe0001');
    writeFileSync(f, `${secret}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
    expect(await resolveCredential('crd_probe0001', { home })).toBe(secret);

    let err: { name?: string; code?: string; message?: string } | undefined;
    try {
      await resolveCredential('crd_missing01', { home });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err, 'a missing secret throws').toBeTruthy();
    expect(err!.name === 'Error' && !err!.code, `typed error (a named class or a code), got ${err!.name}`).toBe(false);
    expect(err!.message ?? '').toMatch(/crd_missing01/);
    expect(err!.message ?? '', 'the message says how to fix it').toMatch(/fw |set|add|create/i);
    expect(JSON.stringify(err) + String(err!.message), 'the error never echoes a secret').not.toContain(secret);

    const loose = join(home, 'creds', 'crd_loose001');
    writeFileSync(loose, `${secret}\n`);
    chmodSync(loose, 0o644);
    await expect((async () => resolveCredential('crd_loose001', { home }))(), 'a 0644 credential file is refused').rejects.toThrow();
  });
});
