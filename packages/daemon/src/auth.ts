// Loopback auth for fwd: a one-time pairing code for the browser (exchanged for an HttpOnly
// session cookie), a token file for the CLI (Bearer), and the DNS-rebinding and cross-origin guards.
// Files live in $FW_HOME/pairing/ with mode 0600; only hashes of session tokens are stored.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { sha256Hex } from '@fw/eventlog';

export const SESSION_COOKIE = 'fw_session';
/** Wrong codes allowed before the pending code is burned (a new one needs `fwd --pair`). */
export const MAX_PAIR_ATTEMPTS = 10;
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // no 0/O, 1/I/L, U

export interface SessionRecord {
  id: string;
  token_sha256: string;
  paired_at: string;
  device_label: string | null;
}

export type Principal =
  | { kind: 'session'; session: SessionRecord }
  | { kind: 'cli' }
  | { kind: 'dev_no_auth' };

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function sameSecret(a: string, b: string): boolean {
  const ha = Buffer.from(sha256Hex(a), 'hex');
  const hb = Buffer.from(sha256Hex(b), 'hex');
  return timingSafeEqual(ha, hb);
}

function newPairingCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export class PairingStore {
  readonly dir: string;
  readonly codePath: string;
  readonly cliTokenPath: string;
  readonly sessionsPath: string;
  private failedAttempts = 0;

  constructor(pairingDir: string) {
    this.dir = pairingDir;
    this.codePath = join(pairingDir, 'code');
    this.cliTokenPath = join(pairingDir, 'cli.token');
    this.sessionsPath = join(pairingDir, 'sessions.json');
  }

  /** Creates cli.token (0600) when missing. Returns its path, never the token. */
  ensureCliToken(): string {
    if (!existsSync(this.cliTokenPath))
      writePrivate(this.cliTokenPath, `${randomBytes(32).toString('hex')}\n`);
    return this.cliTokenPath;
  }

  private cliToken(): string | undefined {
    try {
      return readFileSync(this.cliTokenPath, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  pendingCode(): string | undefined {
    try {
      return readFileSync(this.codePath, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * On a first start (no paired session yet) or when forced, makes sure a pairing code is pending
   * and returns it so the caller can print it. Returns undefined when nothing needs printing.
   */
  ensurePairingCode(force = false): string | undefined {
    if (force) {
      const code = newPairingCode();
      writePrivate(this.codePath, `${code}\n`);
      this.failedAttempts = 0;
      return code;
    }
    const pending = this.pendingCode();
    if (pending) return pending;
    if (this.sessions().length > 0) return undefined;
    return this.ensurePairingCode(true);
  }

  sessions(): SessionRecord[] {
    try {
      const v = JSON.parse(readFileSync(this.sessionsPath, 'utf8')) as unknown;
      return Array.isArray(v) ? (v as SessionRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** Exchanges the pending code for a session. Returns the raw token for the cookie, or a refusal reason. */
  pair(
    code: unknown,
    deviceLabel: string | null,
  ): { token: string; session: SessionRecord } | { refused: string } {
    const pending = this.pendingCode();
    if (!pending)
      return { refused: 'no pairing code is pending; restart fwd with --pair to print a new one' };
    if (typeof code !== 'string' || !sameSecret(normalizeCode(code), normalizeCode(pending))) {
      this.failedAttempts++;
      if (this.failedAttempts >= MAX_PAIR_ATTEMPTS) {
        rmSync(this.codePath, { force: true });
        return { refused: 'too many wrong codes; the code was discarded. Restart fwd with --pair' };
      }
      return { refused: 'pairing code does not match' };
    }
    rmSync(this.codePath, { force: true }); // one-time
    this.failedAttempts = 0;
    const token = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      id: `ses_${randomBytes(8).toString('hex')}`,
      token_sha256: sha256Hex(token),
      paired_at: new Date().toISOString(),
      device_label: deviceLabel,
    };
    writePrivate(this.sessionsPath, `${JSON.stringify([...this.sessions(), session], null, 2)}\n`);
    return { token, session };
  }

  sessionCookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
  }

  /** Who is calling: a paired browser session (cookie) or the CLI (Bearer cli.token). */
  authenticate(req: IncomingMessage): Principal | undefined {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const want = this.cliToken();
      if (want && sameSecret(auth.slice(7).trim(), want)) return { kind: 'cli' };
      return undefined;
    }
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!token) return undefined;
    const h = sha256Hex(token);
    const session = this.sessions().find((s) => sameSecret(s.token_sha256, h));
    return session ? { kind: 'session', session } : undefined;
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** DNS rebinding guard: the Host header must name the loopback address and the port fwd bound. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/**
 * Cross-origin write guard. A write must come from no browser origin (the CLI) or from the
 * daemon's own loopback origin; Sec-Fetch-Site, when a browser sends it, must agree.
 */
export function writeOriginAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const o = origin.toLowerCase();
    if (o !== `http://127.0.0.1:${port}` && o !== `http://localhost:${port}`) return false;
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  return true;
}
