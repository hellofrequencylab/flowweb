import type { DiffFile } from './types';

/** Parse a unified git diff into files and hunks. Lines keep their exact text. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffFile['hunks'][number] | null = null;
  const raw = text.split('\n');
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      file = { path: m ? m[1] : line.slice(11), status: 'modified', hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from')) file.status = 'renamed';
    else if (line.startsWith('@@')) {
      hunk = { header: line, n, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && !line.startsWith('\\')) {
      const op = line[0];
      if (op === '+' || op === '-' || op === ' ') hunk.lines.push({ n, op, text: line.slice(1) });
      else if (line === '') continue;
    }
  }
  return files;
}

export async function sha256Hex(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
