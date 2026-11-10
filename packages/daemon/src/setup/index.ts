// FW-C-039: where a new Owner is in setting FlowWeb up, read from real state only. Six steps in
// order: machine, sign_ins, project, brief, flow, live_site (optional). A step is done only when the
// thing it names is true right now (fwd answers, an account passed its test call, a project is
// labelled, a brief is complete, a flow is on, the live site accepted a recent push). Never from a
// click or a flag set by hand. A step not done carries `fix`: the exact command or place that does
// it, so setup resumes wherever the Owner stopped. No secret is ever read into the report.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reader } from '@fw/eventlog';
import { isCompleteBrief, listProjects, readBriefs } from '@fw/ledger';
import { supervisorView } from '../overseer/index.ts';

export const SETUP_STEPS = ['machine', 'sign_ins', 'project', 'brief', 'flow', 'live_site'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export interface SetupStep {
  id: SetupStepId;
  title: string;
  required: boolean;
  done: boolean;
  /** What was found, in plain words. */
  detail: string;
  /** The command or place that does the step; null when done. */
  fix: string | null;
}

export interface SetupReport {
  ready: boolean;
  /** The first required step not done, or null when ready. */
  next: SetupStepId | null;
  fwd: 'up' | 'down';
  steps: SetupStep[];
  checked_at: string;
}

export interface SetupDeps {
  /** The database, read-only; null when this home has none yet. */
  reader: Reader | null;
  fwHome: string;
  repoRoot: string;
  /** Whether fwd answers on this home's port (fwd itself passes true). */
  fwdUp: boolean;
  /** fwd's port, when known. */
  port?: number;
  now?: Date;
  /** process.versions.node of the process asking. */
  nodeVersion?: string;
}

/** The relay's last accepted push older than this does not count as the live site working. */
export const LIVE_SITE_FRESH_MS = 15 * 60_000;
export const ACCOUNTS_FILE = 'accounts-check.json';
export const RELAY_PUSH_FILE = 'relay-last-push.json';

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const P = 'pnpm fw';

function machine(
  d: SetupDeps,
  accounts: Record<string, unknown> | null,
): Omit<SetupStep, 'id' | 'title' | 'required'> {
  const major = Number((d.nodeVersion ?? process.versions.node).split('.')[0]);
  const where = d.port ? `127.0.0.1:${d.port}` : 'this machine';
  if (d.fwdUp) return { done: true, detail: `fwd answers on ${where}.`, fix: null };
  const start = typeof accounts?.start_command === 'string' ? accounts.start_command : 'pnpm fwd';
  const db = d.reader ? '' : ' This home has no database yet; fwd makes it.';
  return {
    done: false,
    detail: `fwd is not answering on ${where}.${db}`,
    fix:
      major === 22
        ? `Start fwd from the FlowWeb folder: ${start}`
        : `Use Node 22 (this shell runs Node ${major}; for example nvm use 22), then start fwd from the FlowWeb folder: ${start}`,
  };
}

function signIns(accounts: Record<string, unknown> | null): Omit<SetupStep, 'id' | 'title' | 'required'> {
  const fix = `${P} accounts connect, then ${P} accounts check`;
  if (!accounts) return { done: false, detail: 'No account has been checked yet.', fix };
  const list = Array.isArray(accounts.accounts) ? (accounts.accounts as Record<string, unknown>[]) : [];
  const passed = list.filter((a) => a.ok === true).map((a) => String(a.label ?? a.id));
  const failed = list.filter((a) => a.ok === false).map((a) => String(a.label ?? a.id));
  const when = typeof accounts.checked_at === 'string' ? ` (checked ${accounts.checked_at})` : '';
  if (passed.length)
    return {
      done: true,
      detail: `Working: ${passed.join(', ')}${failed.length ? `. Failed: ${failed.join(', ')}` : ''}${when}.`,
      fix: null,
    };
  return {
    done: false,
    detail: failed.length
      ? `Every test call failed: ${failed.join(', ')}${when}.`
      : `No account is set up${when}.`,
    fix,
  };
}

export function setupReport(d: SetupDeps): SetupReport {
  const now = d.now ?? new Date();
  const accounts = readJson(join(d.fwHome, ACCOUNTS_FILE));
  const projects = d.reader ? listProjects(d.reader) : [];
  const labelled = projects.filter((p) => p.brand && p.category);
  const briefs = d.reader ? readBriefs(d.reader) : {};
  const briefed = labelled.filter((p) => isCompleteBrief(briefs[p.id]));
  let flows: { key: string; name: string; enabled: boolean }[] = [];
  if (d.reader) {
    try {
      flows = supervisorView({
        reader: d.reader,
        repoRoot: d.repoRoot,
        fwHome: d.fwHome,
        now: () => now,
      }).flows;
    } catch {
      flows = [];
    }
  }
  const on = flows.filter((f) => f.enabled);
  const push = readJson(join(d.fwHome, RELAY_PUSH_FILE));
  const pushedAt = typeof push?.synced_at === 'string' ? Date.parse(push.synced_at) : Number.NaN;
  const fresh = Number.isFinite(pushedAt) && now.getTime() - pushedAt <= LIVE_SITE_FRESH_MS;

  const unlabelled = projects.find((p) => !p.brand || !p.category);
  const steps: SetupStep[] = [
    { id: 'machine', title: 'Start FlowWeb on this machine', required: true, ...machine(d, accounts) },
    { id: 'sign_ins', title: "Sign in the agents' accounts", required: true, ...signIns(accounts) },
    {
      id: 'project',
      title: 'Make a project with a brand and category',
      required: true,
      done: labelled.length > 0,
      detail: labelled.length
        ? `Labelled: ${labelled.map((p) => `${p.slug} (${p.brand}, ${p.category})`).join(', ')}.`
        : projects.length
          ? `${projects.length} project${projects.length === 1 ? '' : 's'}, none with both a brand and a category.`
          : 'No project yet.',
      fix: labelled.length
        ? null
        : unlabelled
          ? `${P} project label ${unlabelled.slug} --brand <brand> --category <marketing|product|ops|sales|support|finance|other>`
          : `${P} project add <slug> --name "<name>" --brand <brand> --category <marketing|product|ops|sales|support|finance|other>`,
    },
    {
      id: 'brief',
      title: 'Brief the agents on the project',
      required: true,
      done: briefed.length > 0,
      detail: briefed.length
        ? `Briefed: ${briefed.map((p) => p.slug).join(', ')}.`
        : 'No labelled project has a brief yet. The agents read it to know what the project is for.',
      fix: briefed.length ? null : `${P} project brief ${labelled[0]?.slug ?? '<project>'}`,
    },
    {
      id: 'flow',
      title: 'Turn on the first flow',
      required: true,
      done: on.length > 0,
      detail: on.length
        ? `On: ${on.map((f) => f.key).join(', ')}.`
        : flows.length
          ? `Flows here: ${flows.map((f) => f.key).join(', ')}. None is on.`
          : 'No flow found yet.',
      fix: on.length ? null : `${P} supervisor enable ${flows[0]?.key ?? '<flow>'}`,
    },
    {
      id: 'live_site',
      title: 'See it on the live site (optional)',
      required: false,
      done: fresh,
      detail: fresh
        ? `The live site accepted a push at ${push?.synced_at}.`
        : Number.isFinite(pushedAt)
          ? `The last push the live site accepted was at ${push?.synced_at}; the relay is not pushing now.`
          : 'The relay has not pushed to the live site from this machine.',
      fix: fresh
        ? null
        : 'On the live site, open Settings, then Machines, choose Add a machine, and run the relay command it shows on this machine.',
    },
  ];
  const next = steps.find((s) => s.required && !s.done)?.id ?? null;
  return { ready: next === null, next, fwd: d.fwdUp ? 'up' : 'down', steps, checked_at: now.toISOString() };
}
