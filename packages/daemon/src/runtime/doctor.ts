// FW-C-008: `fw doctor`. Runs the same sandbox self-test a run gets (prepareSandbox with the daemon's
// environment, then sandboxSelfTest) in a throwaway run directory under $FW_HOME/runs, removes that
// directory, and returns the report. It reads no database and writes nothing else, so it works on a
// fresh home and while fwd holds the writer lock.
import { randomBytes } from 'node:crypto';
import { prepareSandbox, removeRunDir, type SelfTestReport, sandboxSelfTest } from './sandbox.ts';

export interface DoctorReport {
  home: string;
  sandbox: SelfTestReport;
}

/** The run id prefix of the doctor's throwaway sandbox (never a pipeline run id). */
export const DOCTOR_RUN_PREFIX = 'run_doctor-';

export async function runDoctor(
  fwHome: string,
  opts: { parentEnv?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<DoctorReport> {
  const runId = `${DOCTOR_RUN_PREFIX}${randomBytes(6).toString('hex')}`;
  const sb = prepareSandbox({
    fwHome,
    run_id: runId,
    ...(opts.parentEnv ? { parentEnv: opts.parentEnv } : {}),
  });
  try {
    const sandbox = await sandboxSelfTest(sb, opts.now ? { now: opts.now } : {});
    return { home: fwHome, sandbox };
  } finally {
    removeRunDir(fwHome, runId);
  }
}
