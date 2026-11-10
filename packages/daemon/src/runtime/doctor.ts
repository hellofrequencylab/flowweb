// FW-C-008: `fw doctor`. Runs the same sandbox self-test a run gets (prepareSandbox with the daemon's
// environment, then sandboxSelfTest) in a throwaway run directory under $FW_HOME/runs, removes that
// directory, and returns the report. It writes nothing else, so it works on a fresh home and while fwd
// holds the writer lock.
// FW-C-029: the first-run checklist on top: each check is pass, warn or fail with a one-line detail.
// A detail never holds a secret value: credentials are counted, never read.
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorePolicy } from '@fw/ledger';
import { prepareSandbox, removeRunDir, type SelfTestReport, sandboxSelfTest } from './sandbox.ts';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorReport {
  home: string;
  checks: DoctorCheck[];
  sandbox: SelfTestReport;
}

export interface DoctorOpts {
  parentEnv?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The FlowWeb checkout, for the core policy fallback. */
  repoDir?: string;
  /** When the last backup completed (ISO), null when there was none, undefined when unknown. */
  lastBackupAt?: string | null;
}

const GB = 1024 ** 3;
const BACKUP_STALE_DAYS = 7;

function guard(name: string, fn: () => Omit<DoctorCheck, 'name'>): DoctorCheck {
  try {
    return { name, ...fn() };
  } catch (e) {
    return { name, status: 'fail', detail: (e as Error).message.split('\n')[0] ?? 'check failed' };
  }
}

/** The checks that need no sandbox. Exported for tests. */
export function doctorChecks(
  fwHome: string,
  sandbox: SelfTestReport | null,
  o: DoctorOpts = {},
): DoctorCheck[] {
  const env = o.parentEnv ?? process.env;
  const now = (o.now ?? (() => new Date()))();
  const checks: DoctorCheck[] = [];
  checks.push(
    guard('node', () => {
      const major = Number(process.versions.node.split('.')[0]);
      return major === 22
        ? { status: 'pass', detail: `Node ${process.versions.node}` }
        : { status: 'warn', detail: `Node ${process.versions.node}; FlowWeb is built and tested on Node 22` };
    }),
  );
  checks.push(
    guard('home', () => {
      if (!existsSync(fwHome))
        return { status: 'warn', detail: `${fwHome} does not exist yet; fwd makes it` };
      accessSync(fwHome, constants.W_OK);
      return { status: 'pass', detail: `${fwHome} is writable` };
    }),
  );
  checks.push(
    guard('core_policy', () => {
      const p = loadCorePolicy(o.repoDir ?? process.cwd(), fwHome);
      return { status: 'pass', detail: `${p.path} parses` };
    }),
  );
  checks.push(
    guard('credentials', () => {
      const dir = join(fwHome, 'creds');
      const n = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).length : 0;
      const signins = ['FW_CLAUDE_AUTH', 'FW_CODEX_AUTH'].filter((k) => env[k] === 'signin');
      if (n === 0 && signins.length === 0)
        return {
          status: 'warn',
          detail: 'no stored credential and no sign-in lane; run pnpm fw accounts connect',
        };
      const parts = [`${n} stored credential${n === 1 ? '' : 's'}`, ...signins.map((k) => `${k}=signin`)];
      return { status: 'pass', detail: parts.join(', ') };
    }),
  );
  if (sandbox)
    checks.push({
      name: 'sandbox',
      status: sandbox.level === 'enforced' ? 'pass' : 'warn',
      detail: `sandbox ${sandbox.mode} on ${sandbox.platform}: ${sandbox.level}`,
    });
  checks.push(
    guard('disk', () => {
      const s = statfsSync(existsSync(fwHome) ? fwHome : process.cwd());
      const free = s.bavail * s.bsize;
      const shown = `${(free / GB).toFixed(1)} GB free`;
      if (free < GB / 10) return { status: 'fail', detail: `${shown}; runs need room for worktrees` };
      return { status: free < GB ? 'warn' : 'pass', detail: shown };
    }),
  );
  checks.push(
    guard('clock', () => {
      const y = now.getUTCFullYear();
      return y >= 2024 && y < 2100
        ? { status: 'pass', detail: now.toISOString() }
        : { status: 'fail', detail: `the clock reads ${now.toISOString()}` };
    }),
  );
  if (o.lastBackupAt !== undefined)
    checks.push(
      guard('last_backup', () => {
        if (o.lastBackupAt === null)
          return { status: 'warn', detail: 'no backup yet; run pnpm fw backup --out <file>' };
        const days = (now.getTime() - Date.parse(o.lastBackupAt as string)) / 86_400_000;
        return {
          status: days > BACKUP_STALE_DAYS ? 'warn' : 'pass',
          detail: `last backup ${o.lastBackupAt} (${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} ago)`,
        };
      }),
    );
  return checks;
}

/** The run id prefix of the doctor's throwaway sandbox (never a pipeline run id). */
export const DOCTOR_RUN_PREFIX = 'run_doctor-';

export async function runDoctor(fwHome: string, opts: DoctorOpts = {}): Promise<DoctorReport> {
  const runId = `${DOCTOR_RUN_PREFIX}${randomBytes(6).toString('hex')}`;
  const sb = prepareSandbox({
    fwHome,
    run_id: runId,
    ...(opts.parentEnv ? { parentEnv: opts.parentEnv } : {}),
  });
  try {
    const sandbox = await sandboxSelfTest(sb, opts.now ? { now: opts.now } : {});
    return { home: fwHome, checks: doctorChecks(fwHome, sandbox, opts), sandbox };
  } finally {
    removeRunDir(fwHome, runId);
  }
}
