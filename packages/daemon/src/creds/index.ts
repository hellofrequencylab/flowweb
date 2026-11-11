// WS-P0-029: credential handles v0. A handle (crd_...) names a secret; only this module reads secret
// material. Lookup order: the OS keychain when its command-line tool is on PATH and holds the handle
// (macOS `security`, Linux `secret-tool`), else a file $FW_HOME/creds/<handle> that must be a regular
// file owned by this user with no group or world bits. The value goes into the vendor process
// environment only: never argv, never an event, never a log line. A resolved value is wrapped so that
// JSON.stringify, String() and util.inspect all print a redaction marker.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const HANDLE_RE = /^crd_[0-9A-Za-z]{4,40}$/;
/** Service name the keychain entries live under (account = handle id). */
export const KEYCHAIN_SERVICE = 'flowweb';

export type CredentialErrorCode =
  | 'CREDENTIAL_BAD_HANDLE'
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_INSECURE'
  | 'CREDENTIAL_EMPTY'
  | 'CREDENTIAL_UNREADABLE';

/** Typed error. Messages name the handle and the fix, and never contain the secret. */
export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  readonly handle: string;
  constructor(code: CredentialErrorCode, handle: string, message: string) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    this.handle = handle;
  }
  toJSON(): Record<string, string> {
    return { name: this.name, code: this.code, handle: this.handle, message: this.message };
  }
}

export type CredentialSource = 'keychain' | 'file';

const REDACTED = '[REDACTED:credential]';
const secrets = new WeakMap<ResolvedCredential, string>();

/** A resolved secret. The value is held outside the object, so serializing it can never leak it. */
export class ResolvedCredential {
  readonly handle: string;
  readonly source: CredentialSource;
  constructor(handle: string, source: CredentialSource, value: string) {
    this.handle = handle;
    this.source = source;
    secrets.set(this, value);
  }
  /** The secret. Call only where it is handed to the vendor process environment. */
  reveal(): string {
    return secrets.get(this) ?? '';
  }
  toJSON(): Record<string, string> {
    return { handle: this.handle, source: this.source, value: REDACTED };
  }
  toString(): string {
    return `${this.handle}(${REDACTED})`;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

export interface ResolveOptions {
  /** FW_HOME. */
  home: string;
  /**
   * Try the OS keychain first. Tests pass false to use only the file backend. Default true, except
   * when this process runs the fake vendor (FW_VENDOR=fake, as every probe does): a probe brings its
   * own secret in $FW_HOME/creds, and the Owner's real keychain entry must not shadow it on a Mac.
   */
  keychain?: boolean;
  /** PATH used to find the keychain tool. Default process.env.PATH. */
  path?: string;
}

function onPath(tool: string, pathVar: string | undefined): boolean {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      if (lstatSync(join(dir, tool)).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** The keychain lookup, argv only. The secret comes back on stdout and is never in our argv. */
function fromKeychain(handle: string, pathVar: string | undefined): string | undefined {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin' && onPath('security', pathVar)) {
    cmd = 'security';
    args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', handle, '-w'];
  } else if (process.platform === 'linux' && onPath('secret-tool', pathVar)) {
    cmd = 'secret-tool';
    args = ['lookup', 'service', KEYCHAIN_SERVICE, 'handle', handle];
  } else {
    return undefined;
  }
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: pathVar ?? '', HOME: process.env.HOME ?? '' },
  });
  if (r.status !== 0) return undefined;
  const v = (r.stdout ?? '').replace(/\r?\n$/, '');
  return v.length > 0 ? v : undefined;
}

export function credentialFilePath(home: string, handle: string): string {
  return join(home, 'creds', handle);
}

function fix(home: string, handle: string): string {
  return (
    `create ${credentialFilePath(home, handle)} holding only the secret, with mode 0600 ` +
    `(install -m 600 /dev/stdin ${credentialFilePath(home, handle)}), or add it to the OS keychain ` +
    `under service "${KEYCHAIN_SERVICE}", account/handle "${handle}"`
  );
}

/** Resolves a handle to its secret wrapper. Throws CredentialError. */
export function resolveCredentialHandle(handle: string, opts: ResolveOptions): ResolvedCredential {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle))
    throw new CredentialError(
      'CREDENTIAL_BAD_HANDLE',
      String(handle),
      `credential handle ${JSON.stringify(handle)} is not a handle id (crd_ followed by 4 to 40 letters or digits)`,
    );
  if (opts.keychain ?? process.env.FW_VENDOR !== 'fake') {
    const v = fromKeychain(handle, opts.path ?? process.env.PATH);
    if (v !== undefined) return new ResolvedCredential(handle, 'keychain', v);
  }
  const file = credentialFilePath(opts.home, handle);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    throw new CredentialError(
      'CREDENTIAL_MISSING',
      handle,
      `credential ${handle} is not set: ${fix(opts.home, handle)}`,
    );
  }
  if (!st.isFile())
    throw new CredentialError(
      'CREDENTIAL_INSECURE',
      handle,
      `credential ${handle}: ${file} is not a regular file (symlinks are refused); ${fix(opts.home, handle)}`,
    );
  if ((st.mode & 0o077) !== 0)
    throw new CredentialError(
      'CREDENTIAL_INSECURE',
      handle,
      `credential ${handle}: ${file} has mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}, readable by group or others; run chmod 600 ${file}`,
    );
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new CredentialError(
      'CREDENTIAL_INSECURE',
      handle,
      `credential ${handle}: ${file} is owned by uid ${st.uid}, not this user; ${fix(opts.home, handle)}`,
    );
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new CredentialError(
      'CREDENTIAL_UNREADABLE',
      handle,
      `credential ${handle}: ${file} could not be read; ${fix(opts.home, handle)}`,
    );
  }
  const value = text.replace(/\r?\n$/, '');
  if (value.trim().length === 0)
    throw new CredentialError(
      'CREDENTIAL_EMPTY',
      handle,
      `credential ${handle}: ${file} is empty; ${fix(opts.home, handle)}`,
    );
  return new ResolvedCredential(handle, 'file', value);
}

/** Convenience surface: the secret string for a handle. */
export function resolveCredential(handle: string, opts: ResolveOptions): string {
  return resolveCredentialHandle(handle, opts).reveal();
}

export interface CredentialRequest {
  handle: string;
  /** Vendor process environment variable. */
  env: string;
  required: boolean;
  scopes: string[];
}

export interface InjectedCredentials {
  /** Passed to the adapter as StartOptions.credentialEnv and nowhere else. */
  env: Record<string, string>;
  /** Literal values, for defence-in-depth redaction of anything the daemon writes. */
  literals: string[];
  /** Safe to record: which handles were used and from where (never values). */
  used: { handle: string; env: string; source: CredentialSource }[];
  /** Optional handles that were not set. */
  skipped: { handle: string; env: string; reason: CredentialErrorCode }[];
}

/** Resolves every request; a required one that fails throws, an optional one is skipped. */
export function injectCredentials(
  requests: readonly CredentialRequest[],
  opts: ResolveOptions,
): InjectedCredentials {
  const out: InjectedCredentials = { env: {}, literals: [], used: [], skipped: [] };
  for (const r of requests) {
    let c: ResolvedCredential;
    try {
      c = resolveCredentialHandle(r.handle, opts);
    } catch (e) {
      if (!r.required && e instanceof CredentialError && e.code === 'CREDENTIAL_MISSING') {
        out.skipped.push({ handle: r.handle, env: r.env, reason: e.code });
        continue;
      }
      throw e;
    }
    out.env[r.env] = c.reveal();
    out.literals.push(c.reveal());
    out.used.push({ handle: r.handle, env: r.env, source: c.source });
  }
  return out;
}

/** Replaces each literal secret in text with the redaction marker. */
export function redactLiterals(text: string, literals: readonly string[]): string {
  let out = text;
  for (const lit of literals) if (lit.length >= 4 && out.includes(lit)) out = out.split(lit).join(REDACTED);
  return out;
}
