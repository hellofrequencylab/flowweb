// Redaction before write. Every shape refused by the trg_events_no_secret_shapes trigger in
// schema.core.sql has a pattern here that removes it, so a redacted payload never trips the
// trigger. The trigger stays as the tripwire for anything that bypasses this module.

export const REDACTED = '[REDACTED]';

/** Key added to a payload that had something redacted: the JSON Pointer of every redacted value. */
export const REDACTION_KEY = '_redacted';

// Each pattern covers (at least) the matching GLOB of the trigger.
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]*/g, // GLOB '*sk-ant-*'
  /sk-proj-[A-Za-z0-9_-]*/g, // GLOB '*sk-proj-*'
  /ghp_[A-Za-z0-9]+/g, // GLOB '*ghp_[A-Za-z0-9]*'
  /github_pat_[A-Za-z0-9_]*/g, // GLOB '*github_pat_*'
  /AKIA[0-9A-Z]{4}[0-9A-Z]*/g, // GLOB '*AKIA[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]*'
  /xox[bp]-[A-Za-z0-9-]*/g, // GLOB '*xox[bp]-*'
  // GLOB '*BEGIN * PRIVATE KEY*': a whole PEM block when it is closed, else from BEGIN to the end of
  // the string. Also catches the bare PKCS#8 header "BEGIN PRIVATE KEY", which the GLOB misses.
  /(?:-----)?BEGIN [\s\S]*?PRIVATE KEY(?:[\s\S]*?-----END [^-]*PRIVATE KEY-----|[\s\S]*$)/g,
];

/** True when text still contains something the trigger would refuse (same GLOBs, as regexes). */
export function hasSecretShape(text: string): boolean {
  return /sk-ant-|sk-proj-|ghp_[A-Za-z0-9]|github_pat_|AKIA[0-9A-Z]{4}|xox[bp]-|BEGIN [\s\S]* PRIVATE KEY/.test(
    text,
  );
}

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

const escapePointer = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

export interface RedactionResult<T> {
  value: T;
  /** JSON Pointers (into the original value) of every string or key that was changed. */
  paths: string[];
}

/** Recursively replaces secret-shaped substrings in strings and object keys. Returns a new value. */
export function redactSecrets<T>(value: T): RedactionResult<T> {
  const paths: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      const r = redactString(v);
      if (r !== v) paths.push(path);
      return r;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}/${i}`));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const child = `${path}/${escapePointer(k)}`;
        let rk = redactString(k);
        if (rk !== k) {
          paths.push(child);
          let n = 2;
          while (rk in out) rk = `${redactString(k)}#${n++}`;
        }
        out[rk] = walk(x, child);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, '') as T, paths };
}
