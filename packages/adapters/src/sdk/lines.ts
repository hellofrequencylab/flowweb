// Defensive line splitting for vendor stdout. Lines longer than the cap are dropped (reported by
// length only), and raw PEM private key blocks are swallowed line by line, so a key printed outside
// a JSON string never reaches a preview.

export type RawLine = { kind: 'line'; text: string } | { kind: 'too_long'; byte_length: number };

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export class LineSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private discarding = 0;
  private inPem = false;
  private readonly maxBytes: number;

  constructor(maxBytes = DEFAULT_MAX_LINE_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): RawLine[] {
    const out: RawLine[] = [];
    let data = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) break;
      const lineBuf = data.subarray(0, nl);
      data = data.subarray(nl + 1);
      if (this.discarding > 0) {
        out.push({ kind: 'too_long', byte_length: this.discarding + lineBuf.length });
        this.discarding = 0;
        continue;
      }
      if (lineBuf.length > this.maxBytes) {
        out.push({ kind: 'too_long', byte_length: lineBuf.length });
        continue;
      }
      this.emit(lineBuf, out);
    }
    if (data.length > this.maxBytes) {
      this.discarding += data.length;
      data = Buffer.alloc(0);
    }
    this.buf = Buffer.from(data);
    return out;
  }

  end(): RawLine[] {
    const out: RawLine[] = [];
    if (this.discarding > 0) {
      out.push({ kind: 'too_long', byte_length: this.discarding + this.buf.length });
    } else if (this.buf.length > 0) {
      this.emit(this.buf, out);
    }
    this.buf = Buffer.alloc(0);
    this.discarding = 0;
    return out;
  }

  private emit(lineBuf: Buffer, out: RawLine[]): void {
    const text = lineBuf.toString('utf8').replace(/\r$/, '');
    if (this.inPem) {
      if (PEM_END.test(text)) this.inPem = false;
      out.push({ kind: 'line', text: '[REDACTED:pem_private_key]' });
      return;
    }
    if (PEM_BEGIN.test(text) && !PEM_END.test(text)) {
      // A raw (non-JSON) key block: swallow it until the END marker.
      this.inPem = !text.trimStart().startsWith('{');
    }
    out.push({ kind: 'line', text });
  }
}

/** Short preview of an unparseable line for an error event. Callers redact it as well. */
export function previewOf(text: string, max = 80): string {
  if (/^[A-Za-z0-9+/=]{40,}$/.test(text.trim())) return '[REDACTED:base64_blob]';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?');
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** JSON.parse that never throws. Returns undefined for invalid JSON or a non-object top level. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}
