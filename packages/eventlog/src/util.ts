// Small helpers shared by the event log and the packages built on it.
import { createHash, randomBytes } from 'node:crypto';
import canonicalize from 'canonicalize';

/** RFC 8785 (JCS) canonical JSON. Throws on values JSON cannot represent (undefined root, NaN, cycles). */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError('canonicalJson: value has no JSON representation');
  return out;
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** UTC ISO-8601 timestamp with milliseconds, e.g. 2026-11-08T09:52:10.410Z. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastMs = -1;
let lastRand: number[] = [];

/**
 * A prefixed, ULID-shaped id: `<prefix>_` + 10 base32 chars of millisecond time + 16 random base32 chars.
 * Ids made in the same millisecond by this process sort in creation order (the random part is incremented).
 * The result matches the contracts' id pattern `^[a-z]{2,4}_[0-9A-Za-z]{4,40}$` for a 2 to 4 letter prefix.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!/^[a-z]{2,4}$/.test(prefix))
    throw new RangeError(`newId: prefix must be 2 to 4 lowercase letters: ${prefix}`);
  let rand: number[];
  if (now === lastMs) {
    rand = lastRand.slice();
    let i = rand.length - 1;
    while (i >= 0 && rand[i] === 31) rand[i--] = 0;
    if (i >= 0) rand[i] = (rand[i] ?? 0) + 1;
  } else {
    rand = [...randomBytes(16)].map((b) => b & 31);
  }
  lastMs = now;
  lastRand = rand;
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${time}${rand.map((n) => CROCKFORD[n]).join('')}`;
}
