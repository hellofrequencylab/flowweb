// What ledger rows need before they can be inserted: a project, the agents a row and a work order
// name, and a default backlog stream. Created idempotently through the Writer, one event for each
// thing created (project.created, agent.registered, stream.created). Nothing is created twice and an
// existing project, agent or stream is never changed here.
import type { StreamDefinition } from '@fw/contracts';
import { validate } from '@fw/contracts';
import {
  type ActorKind,
  canonicalJson,
  newId,
  nowIso,
  type Reader,
  sha256Hex,
  type Writer,
} from '@fw/eventlog';
import { LedgerError } from './errors.ts';

export interface Actor {
  kind: ActorKind;
  id: string;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  repo_url?: string | null;
}

/** Agents every Core project starts with. Fleet-wide (no project_id), vendor 'local' until adapters register real ones. */
export const DEFAULT_AGENTS = {
  lead: { id: 'agt_chiefofstaff', name: 'Chief of Staff', role: 'chief_of_staff', tier: 'L1' },
  worker: { id: 'agt_worker0001', name: 'Worker 1', role: 'worker', tier: 'L2' },
  verifier: { id: 'agt_verifier0001', name: 'Verifier 1', role: 'verifier', tier: 'L1' },
} as const;

export const BACKLOG_STREAM_KEY = 'backlog-dev';

export interface Bootstrap {
  projectId: string;
  streamId: string;
  ownerId: string;
  leadAgentId: string;
  workerAgentId: string;
  verifierAgentId: string;
}

/** The single Owner principal from settings('owner'). */
export function ownerId(r: Reader): string {
  const row = r.get<{ value: string }>("SELECT value FROM settings WHERE key = 'owner'");
  const id = row ? (JSON.parse(row.value) as { id?: unknown }).id : undefined;
  if (typeof id !== 'string') throw new LedgerError('NOT_FOUND', "settings('owner') is missing");
  return id;
}

export function ownerActor(r: Reader): Actor {
  return { kind: 'owner', id: ownerId(r) };
}

/** Looks up what bootstrap would create, without writing. Undefined parts are missing. */
export function findBootstrap(
  r: Reader,
  slug: string,
): { [K in keyof Bootstrap]?: Bootstrap[K] | undefined } {
  const project = r.get<{ id: string }>('SELECT id FROM projects WHERE slug = ?', [slug]);
  const stream = project
    ? r.get<{ id: string }>('SELECT id FROM streams WHERE project_id = ? AND key = ?', [
        project.id,
        BACKLOG_STREAM_KEY,
      ])
    : undefined;
  return {
    projectId: project?.id,
    streamId: stream?.id,
    ownerId: ownerId(r),
    leadAgentId: DEFAULT_AGENTS.lead.id,
    workerAgentId: DEFAULT_AGENTS.worker.id,
    verifierAgentId: DEFAULT_AGENTS.verifier.id,
  };
}

function backlogStream(id: string, projectId: string, createdAt: string): StreamDefinition {
  return {
    id,
    key: BACKLOG_STREAM_KEY,
    name: 'Backlog to pull request',
    project_id: projectId,
    version: 1,
    template: 'backlog_dev',
    enabled: true,
    trigger: { type: 'manual' },
    inputs: [
      {
        name: 'ready_rows',
        kind: 'ledger_rows',
        ref: `ledger://${projectId}?status=ready`,
        untrusted: false,
      },
    ],
    tools: [],
    action_classes: ['code_write_sandbox', 'merge_main'],
    output: { artifacts: ['pull_request'], result_schema: 'run-result.json' },
    verifier: { agent_profile: 'verifier', vendor_policy: 'different_vendor_preferred', read_only: true },
    human_gate: { min_tier: 'L3', approver: 'owner', gate_on: ['merge_main'] },
    default_tier: 'L2',
    budget: { caps: { max_usd: 5 }, period: 'day' },
    wip_limit: 2,
    metrics: ['first_pass_acceptance', 'cycle_time_hours_p50'],
    created_at: createdAt,
  } as StreamDefinition;
}

/** Creates the project, default agents and backlog stream when missing. Call inside a transaction. */
export function ensureBootstrap(w: Writer, cfg: ProjectConfig, actor: Actor, now: () => Date): Bootstrap {
  const owner = ownerId(w);
  let project = w.get<{ id: string }>('SELECT id FROM projects WHERE slug = ?', [cfg.slug]);
  if (!project) {
    const id = newId('prj');
    w.run('INSERT INTO projects(id, slug, name, kind, repo_url) VALUES (?, ?, ?, ?, ?)', [
      id,
      cfg.slug,
      cfg.name,
      'repo',
      cfg.repo_url ?? null,
    ]);
    w.appendEvent({
      type: 'project.created',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: id,
      idempotency_key: id,
      payload: { project_id: id, slug: cfg.slug, repo_url: cfg.repo_url ?? null, wip_limit: 3 },
    });
    project = { id };
  }
  for (const a of Object.values(DEFAULT_AGENTS)) {
    if (w.get('SELECT 1 FROM agents WHERE id = ?', [a.id])) continue;
    w.run(
      "INSERT INTO agents(id, name, role, vendor, model, tier, status) VALUES (?, ?, ?, 'local', 'unassigned', ?, 'active')",
      [a.id, a.name, a.role, a.tier],
    );
    w.appendEvent({
      type: 'agent.registered',
      actor_kind: actor.kind,
      actor_id: actor.id,
      idempotency_key: a.id,
      payload: {
        agent_id: a.id,
        role: a.role,
        vendor: 'local',
        model: 'unassigned',
        tool_manifest_hash: null,
        rule_of_two_flags: {},
      },
    });
  }
  let stream = w.get<{ id: string }>('SELECT id FROM streams WHERE project_id = ? AND key = ?', [
    project.id,
    BACKLOG_STREAM_KEY,
  ]);
  if (!stream) {
    const id = newId('stm');
    const def = backlogStream(id, project.id, nowIso(now()));
    const check = validate('stream-definition', def);
    if (!check.ok) throw new Error(`default stream definition is invalid: ${JSON.stringify(check.errors)}`);
    const text = canonicalJson(def);
    const hash = sha256Hex(text);
    w.run(
      `INSERT INTO streams(id, project_id, key, name, template, definition, definition_hash, version, status, default_tier, wip_limit)
       VALUES (?, ?, ?, ?, 'backlog_dev', ?, ?, 1, 'active', 'L2', 2)`,
      [id, project.id, BACKLOG_STREAM_KEY, def.name, text, hash],
    );
    w.appendEvent({
      type: 'stream.created',
      actor_kind: actor.kind,
      actor_id: actor.id,
      project_id: project.id,
      stream_id: id,
      idempotency_key: id,
      payload: { stream_id: id, template: 'backlog_dev', definition_hash: hash },
    });
    stream = { id };
  }
  return {
    projectId: project.id,
    streamId: stream.id,
    ownerId: owner,
    leadAgentId: DEFAULT_AGENTS.lead.id,
    workerAgentId: DEFAULT_AGENTS.worker.id,
    verifierAgentId: DEFAULT_AGENTS.verifier.id,
  };
}
