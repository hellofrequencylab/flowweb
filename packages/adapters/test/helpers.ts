import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ajv2020 from 'ajv/dist/2020.js';
import type { AdapterEvent, AdapterRun, RunMeta, RunResult, VendorAdapterInput } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
export const SCHEMA_DIR = join(REPO_ROOT, 'contracts-core/json-schema');
export const FIXTURES = join(here, 'fixtures');

export interface Worktree {
  path: string;
  base_commit: string;
  cleanup(): void;
}

const GIT_ID = ['-c', 'user.name=fw-test', '-c', 'user.email=test@fw.invalid', '-c', 'commit.gpgsign=false'];

export function makeWorktree(): Worktree {
  const path = mkdtempSync(join(tmpdir(), 'fw-adapters-wt-'));
  const git = (...args: string[]) =>
    execFileSync('git', [...GIT_ID, ...args], { cwd: path, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), '# test worktree\n');
  writeFileSync(join(path, 'CODEOWNERS'), '* @owner\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const base_commit = git('rev-parse', 'HEAD');
  return { path, base_commit, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A schema-valid input built from contracts-core example 19, pointed at a test worktree. */
export function makeInput(
  wt: Worktree,
  patch: (i: VendorAdapterInput) => void = () => {},
): VendorAdapterInput {
  const ex = JSON.parse(
    readFileSync(join(REPO_ROOT, 'contracts-core/examples/19-vendor-adapter-input.json'), 'utf8'),
  ) as VendorAdapterInput;
  ex.run_id = `run_t${Math.random().toString(36).slice(2, 10)}`;
  ex.workspace = { path: wt.path, branch: 'fw/test', base_commit: wt.base_commit, read_only: false };
  ex.work_order.base_commit = wt.base_commit;
  ex.instruction_files = [];
  ex.sandbox = { isolation: 'worktree_only', network_policy: 'deny_all' };
  patch(ex);
  return ex;
}

// ajv is CommonJS; under NodeNext its default import is module.exports, which carries `.default`.
const Ajv2020 = ajv2020.default;
type Ajv = InstanceType<typeof Ajv2020>;

let ajvCache: Ajv | null = null;
function ajv(): Ajv {
  if (ajvCache) return ajvCache;
  const a = new Ajv2020({ strict: false, allErrors: true });
  a.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  a.addFormat('uri', /^[a-z][a-z0-9+.-]*:\S+$/i);
  for (const f of readdirSync(SCHEMA_DIR)) {
    if (f.endsWith('.json')) a.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')));
  }
  ajvCache = a;
  return a;
}

export function schemaErrors(schemaFile: string, value: unknown): string[] {
  const v = ajv().getSchema(`https://contracts.invalid/fw/v1/${schemaFile}`);
  if (!v) throw new Error(`schema not loaded: ${schemaFile}`);
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

export interface Collected {
  events: AdapterEvent[];
  result: RunResult;
  meta: RunMeta;
}

export async function collect(run: AdapterRun): Promise<Collected> {
  const events: AdapterEvent[] = [];
  const drain = (async () => {
    for await (const e of run.events) events.push(e);
  })();
  const [result, meta] = await Promise.all([run.result, run.meta]);
  await drain;
  return { events, result, meta };
}

export function steps(events: AdapterEvent[]) {
  return events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
}

/** True if any process in the group is alive (and not a zombie). */
export function liveGroupMembers(pgid: number): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(rest[2]) === pgid && rest[0] !== 'Z') pids.push(Number(name));
    } catch {
      // raced with exit
    }
  }
  return pids;
}

/** Waits until kill(-pgid, 0) reports ESRCH (zombies may take a moment to be reaped). */
export async function waitGroupGone(pgid: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Fake secret values assembled at runtime so the repository never holds a secret-shaped literal. */
export const FAKE_MARKER = 'FWFAKE';
export function fakeCredential(): string {
  return `${FAKE_MARKER}cred${'Z9'.repeat(10)}`;
}
