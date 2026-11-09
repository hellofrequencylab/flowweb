// WS-P0-029: credential handles. File backend only here (keychain: false); the OS keychain is used
// only when its tool is on PATH and holds the handle.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import {
  CredentialError,
  credentialFilePath,
  injectCredentials,
  redactLiterals,
  resolveCredential,
  resolveCredentialHandle,
} from '../src/creds/index.ts';

const SECRET = 'fwtest-cred-7c1d2e3f4a5b6c7d';
const home = mkdtempSync(join(tmpdir(), 'fw-creds-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, 'creds'), { mode: 0o700 });
const opts = { home, keychain: false };

function put(handle: string, value: string, mode = 0o600): string {
  const p = credentialFilePath(home, handle);
  writeFileSync(p, value);
  chmodSync(p, mode);
  return p;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CredentialError);
    // The message names the handle and a fix, and never the secret.
    expect((e as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(e)).not.toContain(SECRET);
    return (e as CredentialError).code;
  }
  return undefined;
}

describe('credential handles', () => {
  test('a 0600 file resolves; the trailing newline is dropped', () => {
    put('crd_good0001', `${SECRET}\n`);
    expect(resolveCredential('crd_good0001', opts)).toBe(SECRET);
    expect(resolveCredentialHandle('crd_good0001', opts).source).toBe('file');
  });

  test('group- or world-readable files are refused with CREDENTIAL_INSECURE', () => {
    put('crd_group0001', SECRET, 0o640);
    put('crd_world0001', SECRET, 0o604);
    expect(codeOf(() => resolveCredential('crd_group0001', opts))).toBe('CREDENTIAL_INSECURE');
    expect(codeOf(() => resolveCredential('crd_world0001', opts))).toBe('CREDENTIAL_INSECURE');
    try {
      resolveCredential('crd_group0001', opts);
    } catch (e) {
      expect((e as Error).message).toMatch(/crd_group0001.*mode 0640.*chmod 600/);
    }
  });

  test('symlinks, missing, empty and malformed handles each get their typed error', () => {
    const target = put('crd_target001', SECRET);
    symlinkSync(target, credentialFilePath(home, 'crd_link0001'));
    expect(codeOf(() => resolveCredential('crd_link0001', opts))).toBe('CREDENTIAL_INSECURE');
    expect(codeOf(() => resolveCredential('crd_absent001', opts))).toBe('CREDENTIAL_MISSING');
    put('crd_empty0001', '\n');
    expect(codeOf(() => resolveCredential('crd_empty0001', opts))).toBe('CREDENTIAL_EMPTY');
    expect(codeOf(() => resolveCredential('../etc/passwd', opts))).toBe('CREDENTIAL_BAD_HANDLE');
    expect(codeOf(() => resolveCredential('crd_x', opts))).toBe('CREDENTIAL_BAD_HANDLE');
  });

  test('a resolved credential prints as a redaction marker everywhere', () => {
    put('crd_print0001', SECRET);
    const c = resolveCredentialHandle('crd_print0001', opts);
    expect(JSON.stringify({ c })).not.toContain(SECRET);
    expect(String(c)).not.toContain(SECRET);
    expect(`${c}`).not.toContain(SECRET);
    expect(inspect(c)).not.toContain(SECRET);
    expect(inspect({ nested: [c] }, { depth: 5 })).not.toContain(SECRET);
    expect(Object.values(c)).not.toContain(SECRET);
    expect(c.reveal()).toBe(SECRET);
  });

  test('injection: env only; optional missing handles are skipped, required ones throw', () => {
    put('crd_inject001', SECRET);
    const out = injectCredentials(
      [
        { handle: 'crd_inject001', env: 'VENDOR_KEY', required: true, scopes: [] },
        { handle: 'crd_missing01', env: 'OTHER_KEY', required: false, scopes: [] },
      ],
      opts,
    );
    expect(out.env).toEqual({ VENDOR_KEY: SECRET });
    expect(out.used).toEqual([{ handle: 'crd_inject001', env: 'VENDOR_KEY', source: 'file' }]);
    expect(out.skipped).toEqual([
      { handle: 'crd_missing01', env: 'OTHER_KEY', reason: 'CREDENTIAL_MISSING' },
    ]);
    // What is safe to record carries handles, never values.
    expect(JSON.stringify({ used: out.used, skipped: out.skipped })).not.toContain(SECRET);
    expect(
      codeOf(() =>
        injectCredentials([{ handle: 'crd_missing01', env: 'K', required: true, scopes: [] }], opts),
      ),
    ).toBe('CREDENTIAL_MISSING');
    // An optional handle whose file is insecure is not silently skipped.
    put('crd_insec0001', SECRET, 0o644);
    expect(
      codeOf(() =>
        injectCredentials([{ handle: 'crd_insec0001', env: 'K', required: false, scopes: [] }], opts),
      ),
    ).toBe('CREDENTIAL_INSECURE');
  });

  test('literal redaction for anything the daemon writes', () => {
    expect(redactLiterals(`token=${SECRET} again ${SECRET}`, [SECRET])).toBe(
      'token=[REDACTED:credential] again [REDACTED:credential]',
    );
    expect(redactLiterals('abc', ['ab'])).toBe('abc'); // too short to redact safely
  });
});
