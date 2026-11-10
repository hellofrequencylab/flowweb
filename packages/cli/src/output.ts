// Exit codes and printing helpers shared by every command.

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, POLICY: 3, LOCKED: 4 } as const;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * The directory the user ran fw from. `pnpm fw` runs the script from the workspace root and puts
 * where the user typed the command in INIT_CWD. INIT_CWD is trusted only for that `fw` script:
 * any other pnpm script (`pnpm probe`, `pnpm test`) leaks its own INIT_CWD into every child it
 * starts, and an fw spawned there with its own cwd must use that cwd, not the workspace root.
 */
export function invocationCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.npm_lifecycle_event === 'fw' && env.INIT_CWD ? env.INIT_CWD : cwd;
}

export const processIo: Io = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  env: process.env,
  cwd: invocationCwd(process.env, process.cwd()),
};

/** Error codes that are a usage problem (exit 2) rather than a refusal (exit 1). */
const USAGE_CODES = new Set(['BAD_ARGUMENT', 'USAGE']);

/**
 * Error codes that mean a policy refused the request (exit 3), as opposed to a failed check or a
 * row in the wrong state (exit 1). Decision 22 of docs/decisions/C0-owner-questions.md.
 *   SIZE_NOT_DISPATCHABLE  the core policy size table has no caps for the row's size (XL)
 *   SELF_VERIFY            the same agent was named as doer and verifier
 *   DIFF_POLICY            the run's change broke the diff policy (out of scope or a Tier 0 path)
 *   APPROVAL_REQUIRED      a stream tier above L2 named no recorded Owner approval
 *   KILL_SWITCH            dispatch refused because the kill switch is engaged
 *   BUDGET_EXHAUSTED       dispatch refused because a fleet, project, stream or agent budget is spent
 *   OWNER_ONLY             an Owner-only command (fw policy apply) was run inside an agent run
 * A row that is not ready, a held lease or an expired order is not a policy refusal and stays 1.
 */
export const POLICY_CODES: ReadonlySet<string> = new Set([
  'SIZE_NOT_DISPATCHABLE',
  'SELF_VERIFY',
  'DIFF_POLICY',
  'APPROVAL_REQUIRED',
  'KILL_SWITCH',
  'BUDGET_EXHAUSTED',
  'OWNER_ONLY',
]);

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
  if (POLICY_CODES.has(err.code)) return EXIT.POLICY;
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

/** A dollar figure, or `unknown` when no cost was reported (never $0 for a missing cost). */
export const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? 'unknown' : `$${v.toFixed(4)}`;
