// Exit codes and printing helpers shared by every command.

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, POLICY: 3, LOCKED: 4 } as const;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const processIo: Io = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  env: process.env,
  // `pnpm fw` runs the script from the workspace root; INIT_CWD is where the user typed the command.
  cwd: process.env.INIT_CWD ?? process.cwd(),
};

/** Error codes that are a usage problem (exit 2) rather than a refusal (exit 1). */
const USAGE_CODES = new Set(['BAD_ARGUMENT', 'USAGE']);

export interface CliError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Normalises anything thrown by a client into a code, a message and details. */
export function toCliError(e: unknown): CliError {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const details = (e as { details?: unknown }).details;
    return {
      code: typeof code === 'string' ? code : 'INTERNAL',
      message: e.message,
      ...(details && typeof details === 'object' ? { details: details as Record<string, unknown> } : {}),
    };
  }
  return { code: 'INTERNAL', message: String(e) };
}

export function exitCodeFor(err: CliError): number {
  if (err.code === 'LOCKED') return EXIT.LOCKED;
  if (USAGE_CODES.has(err.code)) return EXIT.USAGE;
  return EXIT.FAILED;
}

/** Fixed-width columns; the last column is not padded. */
export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export const short = (h: string | null | undefined, n = 12) => (h ? h.slice(0, n) : '-');
