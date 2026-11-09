// FW_HOME layout helpers and the path traversal guard for per-run directories.
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Run ids follow the schema (`run_%`) and are restricted to a safe character set. */
export const RUN_ID_RE = /^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Row ids such as WS-P0-032 or FW-C-008; restricted so they are safe in a branch name. */
export const ROW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/** FW_HOME from the environment, defaulting to ~/.flowweb. Always absolute. */
export function resolveFwHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.FW_HOME;
  return resolve(v && v.length > 0 ? v : join(homedir(), '.flowweb'));
}

export function assertRunId(runId: string): void {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new UnsafePathError(`invalid run id: ${JSON.stringify(runId)}`);
  }
}

export function assertRowId(rowId: string): void {
  if (typeof rowId !== 'string' || !ROW_ID_RE.test(rowId)) {
    throw new UnsafePathError(`invalid row id: ${JSON.stringify(rowId)}`);
  }
}

/** True when child is root itself or strictly inside it (both resolved). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/**
 * Returns `<fwHome>/<area>/<runId>` after validating the run id and checking that the result is a direct
 * child of the area directory. A run can never get a path outside it.
 */
export function runScopedPath(fwHome: string, area: 'worktrees' | 'runs', runId: string): string {
  assertRunId(runId);
  const root = resolve(fwHome, area);
  const p = resolve(root, runId);
  if (relative(root, p) !== runId) {
    throw new UnsafePathError(`run path escapes ${root}: ${runId}`);
  }
  return p;
}
