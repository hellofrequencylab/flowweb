// Project labels: which brand or business a project belongs to (free text, for example
// "Frequency") and what kind of work it is (a short fixed list). Stored as one JSON document in
// the settings table under PROJECT_LABELS_KEY, keyed by project id, so labelling needs no schema
// change. Every change writes one project.updated event naming the fields that changed.
import type { Reader, Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from '../bootstrap.ts';
import { LedgerError } from '../errors.ts';

export const PROJECT_LABELS_KEY = 'project_labels';

export const PROJECT_CATEGORIES = [
  'marketing',
  'product',
  'ops',
  'sales',
  'support',
  'finance',
  'other',
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

export interface ProjectLabels {
  brand: string | null;
  category: ProjectCategory | null;
}

export interface ProjectView extends ProjectLabels {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: string;
  repo_url: string | null;
  created_at: string;
}

export interface ProjectFilter {
  brand?: string;
  category?: string;
}

export interface LabelChange {
  /** A brand name; empty string or null clears it. */
  brand?: string | null;
  /** One of PROJECT_CATEGORIES; empty string or null clears it. */
  category?: string | null;
}

export interface LabelReport {
  project: ProjectView;
  changed_fields: (keyof ProjectLabels)[];
  event_seq: number | null;
}

const BRAND_MAX = 64;
type LabelMap = Record<string, Partial<ProjectLabels>>;

/** The stored labels document; an unreadable or missing one is an empty map. */
export function readLabels(r: Reader): LabelMap {
  const row = r.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [PROJECT_LABELS_KEY]);
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as LabelMap) : {};
  } catch {
    return {};
  }
}

function labelsOf(map: LabelMap, id: string): ProjectLabels {
  const l = map[id] ?? {};
  const category = PROJECT_CATEGORIES.includes(l.category as ProjectCategory)
    ? (l.category as ProjectCategory)
    : null;
  return { brand: typeof l.brand === 'string' && l.brand ? l.brand : null, category };
}

/** Same brand regardless of case or spacing: "frequency " matches "Frequency". */
export const sameBrand = (a: string | null, b: string): boolean =>
  a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

function normalizeBrand(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > BRAND_MAX) throw new LedgerError('BAD_ARGUMENT', `brand is at most ${BRAND_MAX} characters`);
  return s;
}

function normalizeCategory(v: string | null | undefined): ProjectCategory | null {
  if (v === undefined || v === null || v.trim() === '') return null;
  const s = v.trim().toLowerCase();
  if (!PROJECT_CATEGORIES.includes(s as ProjectCategory))
    throw new LedgerError('BAD_ARGUMENT', `category must be one of ${PROJECT_CATEGORIES.join(', ')}`);
  return s as ProjectCategory;
}

const PROJECT_COLUMNS = 'id, slug, name, kind, status, repo_url, created_at';

/** Every project with its labels, oldest first, narrowed by brand and category when given. */
export function listProjects(r: Reader, filter: ProjectFilter = {}): ProjectView[] {
  const category = filter.category ? normalizeCategory(filter.category) : null;
  const map = readLabels(r);
  return r
    .all<Omit<ProjectView, keyof ProjectLabels>>(
      `SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at, id`,
    )
    .map((p) => ({ ...p, ...labelsOf(map, p.id) }))
    .filter((p) => (filter.brand ? sameBrand(p.brand, filter.brand) : true))
    .filter((p) => (category ? p.category === category : true));
}

/** Finds a project by id or slug. */
export function findProject(r: Reader, ref: string): ProjectView {
  const p = r.get<Omit<ProjectView, keyof ProjectLabels>>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? OR slug = ?`,
    [ref, ref],
  );
  if (!p) throw new LedgerError('NOT_FOUND', `no project ${ref}`);
  return { ...p, ...labelsOf(readLabels(r), p.id) };
}

/**
 * Sets or clears a project's brand and category. Fields left undefined keep their value. Writes the
 * settings document and one project.updated event in one transaction; a change that changes
 * nothing writes nothing.
 */
export function labelProject(w: Writer, ref: string, change: LabelChange, actor?: Actor): LabelReport {
  return w.transaction(() => {
    const by = actor ?? ownerActor(w);
    const project = findProject(w, ref);
    const next: ProjectLabels = {
      brand: change.brand === undefined ? project.brand : normalizeBrand(change.brand),
      category: change.category === undefined ? project.category : normalizeCategory(change.category),
    };
    const changed = (['brand', 'category'] as const).filter((k) => next[k] !== project[k]);
    if (changed.length === 0) return { project, changed_fields: [], event_seq: null };

    const map = readLabels(w);
    if (next.brand === null && next.category === null) delete map[project.id];
    else map[project.id] = next;
    const value = JSON.stringify(map);
    const owner = ownerActor(w).id;
    w.run(
      `INSERT INTO settings(key, value, trust_tier, description, updated_by) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      [PROJECT_LABELS_KEY, value, 'Brand and category of each project, keyed by project id', owner],
    );
    const version = w.get<{ version: number }>('SELECT version FROM settings WHERE key = ?', [
      PROJECT_LABELS_KEY,
    ])!.version;
    const ev = w.appendEvent({
      type: 'project.updated',
      actor_kind: by.kind,
      actor_id: by.id,
      project_id: project.id,
      idempotency_key: `${project.id}:labels:${version}`,
      payload: { project_id: project.id, changed_fields: changed, changed_by: by.id, ...next },
    });
    return { project: { ...project, ...next }, changed_fields: [...changed], event_seq: ev.seq };
  });
}
