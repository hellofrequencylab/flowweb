// Project labels: brand and category per project, kept in settings('project_labels'), one
// project.updated event per change.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { labelProject, listProjects, PROJECT_LABELS_KEY } from '../src/projects/labels.ts';
import { fileStore, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();
const store = fileStore(dir);
const projectId = syncInto(store, writeRows(join(dir, 'rows'), [row('FW-C-941')])).project_id!;
const w = store.writer!;

const updates = () =>
  w.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'project.updated' AND project_id = ?", [
    projectId,
  ]);

describe('project labels', () => {
  test('a new project has no brand and no category', () => {
    expect(listProjects(w)).toEqual([
      expect.objectContaining({ id: projectId, brand: null, category: null }),
    ]);
  });

  test('labelling by slug stores both labels and writes one project.updated event', () => {
    const r = labelProject(w, 'test-project', { brand: '  Frequency ', category: 'Marketing' });
    expect(r.project).toMatchObject({ id: projectId, brand: 'Frequency', category: 'marketing' });
    expect(r.changed_fields).toEqual(['brand', 'category']);
    const ev = updates();
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload)).toMatchObject({
      project_id: projectId,
      changed_fields: ['brand', 'category'],
      brand: 'Frequency',
      category: 'marketing',
    });
    const stored = w.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [PROJECT_LABELS_KEY]);
    expect(JSON.parse(stored!.value)).toEqual({ [projectId]: { brand: 'Frequency', category: 'marketing' } });
  });

  test('the same labels again change nothing and write no event', () => {
    const r = labelProject(w, projectId, { brand: 'Frequency', category: 'marketing' });
    expect(r.changed_fields).toEqual([]);
    expect(r.event_seq).toBeNull();
    expect(updates()).toHaveLength(1);
  });

  test('filters by brand (any case) and category', () => {
    expect(listProjects(w, { brand: 'frequency' }).map((p) => p.id)).toEqual([projectId]);
    expect(listProjects(w, { category: 'marketing' }).map((p) => p.id)).toEqual([projectId]);
    expect(listProjects(w, { brand: 'Other brand' })).toEqual([]);
    expect(listProjects(w, { category: 'ops' })).toEqual([]);
  });

  test('refuses an unknown category and an unknown project, writing nothing', () => {
    expect(() => labelProject(w, projectId, { category: 'growth hacking' })).toThrow(
      /category must be one of/,
    );
    expect(() => labelProject(w, 'no-such-project', { brand: 'X' })).toThrow(/no project/);
    expect(() => listProjects(w, { category: 'nope' })).toThrow(/category must be one of/);
    expect(updates()).toHaveLength(1);
  });

  test('clearing one label keeps the other; clearing both removes the entry', () => {
    expect(labelProject(w, projectId, { category: '' }).project).toMatchObject({
      brand: 'Frequency',
      category: null,
    });
    labelProject(w, projectId, { brand: null });
    const stored = w.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [PROJECT_LABELS_KEY]);
    expect(JSON.parse(stored!.value)).toEqual({});
    expect(updates()).toHaveLength(3);
  });
});
