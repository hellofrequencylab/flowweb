// FW-C-008: `fw gc`. Removes run directories ($FW_HOME/runs/<run_id>) of runs that can no longer
// use them, through removeRunDir. It never touches worktrees, branches or the database.
//
// A directory is removed when its run is in a terminal state, or when the database has no such run
// (a self-test leftover, or a home whose database was never created): a pipeline run inserts its
// runs row before it creates its directory, so a directory without a row has no run behind it. A
// run that is queued, starting, running, paused or validating is always kept. A name that is not a
// run id is skipped and reported, never removed.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_ID_RE } from './paths.ts';
import { removeRunDir } from './sandbox.ts';

export const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'timed_out', 'killed', 'cancelled'] as const;

export interface GcEntry {
  run_id: string;
  path: string;
  /** The run's status, or null when the database has no such run. */
  status: string | null;
}

export interface GcReport {
  home: string;
  removed: GcEntry[];
  kept: GcEntry[];
  /** Entries under runs/ that are not run directories (left alone). */
  skipped: { name: string; reason: string }[];
}

/**
 * statusOf returns a run's status, or undefined when the database has no such run. It must throw
 * rather than guess when it cannot read the database, so nothing is removed on a read failure.
 */
export function gcRunDirs(fwHome: string, statusOf: (runId: string) => string | undefined): GcReport {
  const report: GcReport = { home: fwHome, removed: [], kept: [], skipped: [] };
  const runs = join(fwHome, 'runs');
  if (!existsSync(runs)) return report;
  const terminal = new Set<string>(TERMINAL_RUN_STATES);
  for (const d of readdirSync(runs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory()) {
      report.skipped.push({ name: d.name, reason: 'not a directory' });
      continue;
    }
    if (!RUN_ID_RE.test(d.name)) {
      report.skipped.push({ name: d.name, reason: 'not a run id' });
      continue;
    }
    const status = statusOf(d.name) ?? null;
    const entry: GcEntry = { run_id: d.name, path: join(runs, d.name), status };
    if (status !== null && !terminal.has(status)) {
      report.kept.push(entry);
      continue;
    }
    const r = removeRunDir(fwHome, d.name);
    report.removed.push({ ...entry, path: r.path });
  }
  return report;
}
