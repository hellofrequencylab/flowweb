// FW-C-038: making a project that is not a code repository, and the Owner's brief for it.
// A project made here has no repo_url; a repository project still comes from `fw ledger sync`.
// The brief is the Owner's own answers to five plain questions, stored word for word (trimmed) in
// settings('project_briefs') keyed by project id, so it needs no schema change. All five answers
// or nothing: a missing or blank answer is refused and nothing is written.
import { newId, type Reader, type Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from '../bootstrap.ts';
import { LedgerError } from '../errors.ts';
import { findProject, labelProject, type ProjectView } from './labels.ts';

export const PROJECT_BRIEFS_KEY = 'project_briefs';

/** The five questions, in the order they are asked. The keys are the stored field names. */
export const BRIEF_QUESTIONS = [
  { key: 'what', question: 'What is this project, in one or two sentences?' },
  { key: 'who', question: 'Who is it for?' },
  { key: 'voice', question: 'How should it sound? Name the voice in a few words.' },
  { key: 'never', question: 'What must the agents never do on it?' },
  { key: 'done', question: 'What does done look like? Something you could check.' },
] as const;
export type BriefKey = (typeof BRIEF_QUESTIONS)[number]['key'];
export const BRIEF_KEYS: BriefKey[] = BRIEF_QUESTIONS.map((q) => q.key);
const ANSWER_MAX = 1000;

export type BriefAnswers = Record<BriefKey, string>;
export interface ProjectBrief extends BriefAnswers {
  updated_at: string;
}

export const PROJECT_KINDS = ['repo', 'inbox', 'calendar', 'helpdesk', 'docs', 'ops', 'other'] as const;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ProjectAdd {
  slug: string;
  name?: string;
  kind?: string;
  brand?: string | null;
  category?: string | null;
}

export interface ProjectAddReport {
  project: ProjectView;
  event_seq: number;
}

export interface BriefReport {
  project: ProjectView;
  brief: ProjectBrief | null;
  event_seq: number | null;
}

function upsertSetting(w: Writer, key: string, value: unknown, description: string): number {
  w.run(
    `INSERT INTO settings(key, value, trust_tier, description, updated_by) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [key, JSON.stringify(value), description, ownerActor(w).id],
  );
  return w.get<{ version: number }>('SELECT version FROM settings WHERE key = ?', [key])!.version;
}

/** Creates a project with no repository, labelled when brand or category are given. */
export function addProject(w: Writer, input: ProjectAdd, actor?: Actor): ProjectAddReport {
  const slug = String(input.slug ?? '').trim();
  if (!SLUG_RE.test(slug))
    throw new LedgerError(
      'BAD_ARGUMENT',
      'a project slug is lower-case letters, digits and dashes, starting with a letter or digit (at most 63)',
    );
  const kind = input.kind?.trim() || 'other';
  if (!(PROJECT_KINDS as readonly string[]).includes(kind))
    throw new LedgerError('BAD_ARGUMENT', `kind must be one of ${PROJECT_KINDS.join(', ')}`);
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ') || slug;
  if (name.length > 120) throw new LedgerError('BAD_ARGUMENT', 'a project name is at most 120 characters');
  return w.transaction(() => {
    const by = actor ?? ownerActor(w);
    if (w.get('SELECT 1 FROM projects WHERE slug = ?', [slug]))
      throw new LedgerError('ALREADY_EXISTS', `a project with slug ${slug} already exists`);
    const id = newId('prj');
    w.run('INSERT INTO projects(id, slug, name, kind, repo_url) VALUES (?, ?, ?, ?, NULL)', [
      id,
      slug,
      name,
      kind,
    ]);
    const ev = w.appendEvent({
      type: 'project.created',
      actor_kind: by.kind,
      actor_id: by.id,
      project_id: id,
      idempotency_key: id,
      payload: { project_id: id, slug, repo_url: null, wip_limit: 3 },
    });
    let seq = ev.seq;
    if ((input.brand ?? '') !== '' || (input.category ?? '') !== '') {
      const change: { brand?: string | null; category?: string | null } = {};
      if (input.brand) change.brand = input.brand;
      if (input.category) change.category = input.category;
      seq = labelProject(w, id, change, by).event_seq ?? seq;
    }
    return { project: findProject(w, id), event_seq: seq };
  });
}

/** The stored briefs document; an unreadable or missing one is an empty map. */
export function readBriefs(r: Reader): Record<string, ProjectBrief> {
  const row = r.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [PROJECT_BRIEFS_KEY]);
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ProjectBrief>) : {};
  } catch {
    return {};
  }
}

/** A brief counts only when every answer is there and not blank. */
export function isCompleteBrief(b: unknown): b is ProjectBrief {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return BRIEF_KEYS.every((k) => typeof o[k] === 'string' && (o[k] as string).trim() !== '');
}

export function getBrief(r: Reader, ref: string): BriefReport {
  const project = findProject(r, ref);
  const b = readBriefs(r)[project.id];
  return { project, brief: isCompleteBrief(b) ? b : null, event_seq: null };
}

/** Checks all five answers; throws BAD_ARGUMENT naming the first missing or blank one. */
export function checkBrief(answers: Partial<Record<string, unknown>>): BriefAnswers {
  const out = {} as BriefAnswers;
  for (const q of BRIEF_QUESTIONS) {
    const v = answers[q.key];
    if (typeof v !== 'string' || v.trim() === '')
      throw new LedgerError('BAD_ARGUMENT', `the brief needs an answer to "${q.question}" (--${q.key})`);
    const s = v.trim();
    if (s.length > ANSWER_MAX)
      throw new LedgerError('BAD_ARGUMENT', `--${q.key} is at most ${ANSWER_MAX} characters`);
    out[q.key] = s;
  }
  return out;
}

/** Saves the Owner's brief for a project: all five answers, word for word, or nothing. */
export function briefProject(
  w: Writer,
  ref: string,
  answers: Partial<Record<string, unknown>>,
  actor?: Actor,
): BriefReport {
  const checked = checkBrief(answers);
  return w.transaction(() => {
    const by = actor ?? ownerActor(w);
    const project = findProject(w, ref);
    const map = readBriefs(w);
    const old = map[project.id];
    if (isCompleteBrief(old) && BRIEF_KEYS.every((k) => old[k] === checked[k]))
      return { project, brief: old, event_seq: null };
    const brief: ProjectBrief = { ...checked, updated_at: new Date().toISOString() };
    map[project.id] = brief;
    const version = upsertSetting(
      w,
      PROJECT_BRIEFS_KEY,
      map,
      "The Owner's brief for each project, keyed by id",
    );
    const changed = BRIEF_KEYS.filter((k) => !old || old[k] !== checked[k]);
    const ev = w.appendEvent({
      type: 'project.updated',
      actor_kind: by.kind,
      actor_id: by.id,
      project_id: project.id,
      idempotency_key: `${project.id}:brief:${version}`,
      payload: {
        project_id: project.id,
        changed_fields: ['brief'],
        brief_fields: changed,
        changed_by: by.id,
      },
    });
    return { project, brief, event_seq: ev.seq };
  });
}
