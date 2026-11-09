// Secret-shaped string redaction. Every event and every run result passes through here before it
// leaves the adapter. Patterns cover the vendor and platform token shapes listed in the adapter
// spec; literal credential values injected for a run are redacted too.

export interface SecretPattern {
  kind: string;
  re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'pem_private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { kind: 'openai_project_key', re: /sk-proj-[A-Za-z0-9_-]{8,}/g },
  { kind: 'github_pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'aws_access_key', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { kind: 'slack_token', re: /xox[bpas]-[A-Za-z0-9-]{8,}/g },
];

const MIN_LITERAL_LENGTH = 8;

export class Redactor {
  private readonly literals: string[];

  constructor(literalSecrets: Iterable<string> = []) {
    this.literals = [...new Set([...literalSecrets].filter((s) => s.length >= MIN_LITERAL_LENGTH))].sort(
      (a, b) => b.length - a.length,
    );
  }

  text(input: string): string {
    let out = input;
    for (const lit of this.literals) {
      if (out.includes(lit)) out = out.split(lit).join('[REDACTED:credential]');
    }
    for (const p of SECRET_PATTERNS) {
      p.re.lastIndex = 0;
      out = out.replace(p.re, `[REDACTED:${p.kind}]`);
    }
    return out;
  }

  /** Deep copy with every string (object keys included) redacted. */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[this.text(k)] = this.walk(v);
      return out;
    }
    return value;
  }
}

/** Kinds of secret-shaped strings found in text. Empty when clean. */
export function findSecrets(text: string): string[] {
  const found: string[] = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) found.push(p.kind);
    p.re.lastIndex = 0;
  }
  return found;
}
