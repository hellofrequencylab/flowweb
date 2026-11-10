// The project a shipped flow belongs to. A flow directory may hold project.json naming the project
// its stream.json points at (id, slug, name, kind) and its default labels (brand, category). When
// the Owner turns a flow on, fwd creates that project if it is missing and labels it if it has no
// labels yet, so the flow shows up under its brand with no extra step. The Owner's labels are kept.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writer } from '@fw/eventlog';
import { labelProject, listProjects, ownerActor } from '@fw/ledger';

const KINDS = new Set(['repo', 'inbox', 'calendar', 'helpdesk', 'docs', 'ops', 'other']);

export interface FlowProject {
  id: string;
  slug: string;
  name: string;
  kind: string;
  brand?: string;
  category?: string;
}

function parse(raw: unknown): FlowProject | null {
  const p = raw as Partial<FlowProject> | null;
  if (!p || typeof p.id !== 'string' || !p.id.startsWith('prj_')) return null;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string') return null;
  const kind = typeof p.kind === 'string' && KINDS.has(p.kind) ? p.kind : 'other';
  return { ...p, kind } as FlowProject;
}

/** Every flows/<key>/project.json that parses; a broken one is reported and skipped. */
export function flowProjects(
  repoRoot: string,
  warn: (m: string) => void = () => {},
  only?: string,
): FlowProject[] {
  const dir = join(repoRoot, 'flows');
  if (!existsSync(dir)) return [];
  const out: FlowProject[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name, 'project.json');
    if (!e.isDirectory() || (only !== undefined && e.name !== only) || !existsSync(file)) continue;
    let p: FlowProject | null = null;
    try {
      p = parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      p = null;
    }
    if (p) out.push(p);
    else warn(`flows/${e.name}/project.json is not a valid project; skipped`);
  }
  return out;
}

/** Creates a flow's project (every flow's, without `only`) when missing and labels it when it has none. */
export function registerFlowProjects(
  w: Writer,
  repoRoot: string,
  warn: (m: string) => void = () => {},
  only?: string,
) {
  const created: string[] = [];
  const labelled: string[] = [];
  for (const p of flowProjects(repoRoot, warn, only)) {
    w.transaction(() => {
      const byId = w.get<{ id: string }>('SELECT id FROM projects WHERE id = ?', [p.id]);
      if (!byId) {
        if (w.get('SELECT 1 FROM projects WHERE slug = ?', [p.slug])) {
          warn(`flow project ${p.id}: slug ${p.slug} is taken by another project; skipped`);
          return;
        }
        const by = ownerActor(w);
        w.run('INSERT INTO projects(id, slug, name, kind) VALUES (?, ?, ?, ?)', [
          p.id,
          p.slug,
          p.name,
          p.kind,
        ]);
        w.appendEvent({
          type: 'project.created',
          actor_kind: by.kind,
          actor_id: by.id,
          project_id: p.id,
          idempotency_key: p.id,
          payload: { project_id: p.id, slug: p.slug, repo_url: null, wip_limit: 3 },
        });
        created.push(p.id);
      }
      const now = listProjects(w).find((x) => x.id === p.id);
      if (now && now.brand === null && now.category === null && (p.brand || p.category)) {
        labelProject(w, p.id, { brand: p.brand ?? null, category: p.category ?? null });
        labelled.push(p.id);
      }
    });
  }
  return { created, labelled };
}
